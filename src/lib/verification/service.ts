import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { sendOtpEmail } from "@/lib/mailer";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import {
  CANAL,
  LIVRAISON,
  LONGUEUR_CODE,
  canalParDefaut,
  canalValide,
  expirationDepuis,
  finaliteValide,
  motifDeRefus,
  politiquePour,
} from "./politique.mjs";

/**
 * Émission et vérification des codes. La POLITIQUE (durées, plafonds) vit dans
 * `politique.mjs`, sans dépendance ; ce fichier ne fait que l'appliquer à la
 * base et aux canaux de livraison.
 */

/**
 * Tire un code à six chiffres IMPRÉVISIBLE.
 *
 * 🔴 `crypto.randomInt` et non `Math.random()`. L'ancienne implémentation
 * utilisait `Math.floor(100000 + Math.random() * 900000)` : `Math.random()` est
 * un générateur non cryptographique dont l'état interne se reconstitue à partir
 * de quelques sorties observées. Pour un second facteur, cela revient à rendre
 * le code devinable par qui détient déjà le mot de passe — c'est-à-dire à
 * supprimer le facteur.
 *
 * `randomInt(0, 10**6)` puis remplissage à gauche, plutôt qu'un tirage dans
 * [100000, 999999] : cela conserve les codes commençant par zéro, donc le
 * million d'entrées complet. Les exclure retirerait 10 % de l'espace sans
 * qu'aucun contrôle ne le signale.
 */
function tirerCode(): string {
  const max = 10 ** LONGUEUR_CODE;
  return crypto.randomInt(0, max).toString().padStart(LONGUEUR_CODE, "0");
}

/** Empreinte salée d'un code. Le code brut n'est jamais stocké. */
function empreinte(code: string, sel: string): string {
  return crypto.createHash("sha256").update(`${sel}:${code}`).digest("hex");
}

/**
 * Comparaison à TEMPS CONSTANT.
 *
 * Une comparaison par `===` s'arrête au premier caractère qui diffère : le
 * temps de réponse dépend alors du nombre de caractères corrects, ce qui laisse
 * retrouver l'empreinte octet par octet. On compare les empreintes, de longueur
 * fixe, donc `timingSafeEqual` ne peut pas lever sur des tailles différentes.
 */
function memeEmpreinte(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export type ResultatEmission =
  | { ok: true; id: string; expireA: Date; canal: string }
  | {
      ok: false;
      motif:
        | "FINALITE_INCONNUE"
        | "CANAL_INCONNU"
        | "COMPTE_INTROUVABLE"
        | "TROP_DE_DEMANDES"
        | "NON_REMIS";
      detail?: string;
    };

/**
 * Émet un code et le livre. **Gratuit** — décision du user du 18/08/2026 : un
 * solde à zéro ne doit jamais pouvoir empêcher quelqu'un de se connecter.
 *
 * ⚠️ L'ORDRE DES ÉTAPES EST LA SÉCURITÉ. Les plafonds sont contrôlés AVANT le
 * tirage : compter après aurait laissé chaque demande refusée créer quand même
 * une ligne, donc fausser le compteur suivant.
 */
export async function emettreCode(params: {
  developerId: string;
  finalite: string;
  destination: string;
  canal?: string | null;
  ip?: string | null;
}): Promise<ResultatEmission> {
  const { developerId, finalite, destination } = params;

  if (!finaliteValide(finalite)) return { ok: false, motif: "FINALITE_INCONNUE" };
  const politique = politiquePour(finalite)!;

  const canal = params.canal ?? canalParDefaut(finalite);
  if (!canalValide(canal)) return { ok: false, motif: "CANAL_INCONNU" };

  const maintenant = new Date();
  const ilYAUneHeure = new Date(maintenant.getTime() - 3_600_000);

  // Plafonds d'ÉMISSION. Sans eux, le plafond d'essais se contourne en
  // redemandant un code neuf à chaque tentative.
  const parDestination = await prisma.verification.count({
    where: { destination, finalite, createdAt: { gte: ilYAUneHeure } },
  });
  if (parDestination >= politique.maxParDestinationParHeure) {
    return { ok: false, motif: "TROP_DE_DEMANDES" };
  }

  if (params.ip) {
    const parIp = await prisma.verification.count({
      where: { ipDemande: params.ip, createdAt: { gte: ilYAUneHeure } },
    });
    if (parIp >= politique.maxParIpParHeure) {
      return { ok: false, motif: "TROP_DE_DEMANDES" };
    }
  }

  const code = tirerCode();
  const sel = crypto.randomBytes(16).toString("hex");
  const expireA = expirationDepuis(finalite, maintenant)!;

  // L'expéditeur d'un message Alanya : le compte qui porte la clé API.
  const compte = await prisma.developerAccount.findUnique({
    where: { id: developerId },
    select: { userId: true },
  });
  if (!compte) return { ok: false, motif: "COMPTE_INTROUVABLE" };

  /*
   * Invalidation PUIS insertion, dans la MÊME transaction.
   *
   * L'index unique partiel interdit deux codes vivants pour un même couple
   * (destination, finalité) : sans transaction, deux demandes simultanées
   * verraient toutes deux « rien à invalider » et la seconde insertion
   * échouerait. La transaction sérialise, et l'index reste le garde-fou de
   * dernier recours — y compris face à une écriture directe du second système
   * qui partage cette base.
   */
  const ligne = await prisma.$transaction(async (tx) => {
    await tx.verification.updateMany({
      where: {
        destination,
        finalite,
        consommeA: null,
        livraison: { not: LIVRAISON.REMPLACE },
      },
      data: { livraison: LIVRAISON.REMPLACE },
    });

    return tx.verification.create({
      data: {
        developerId,
        finalite,
        canal,
        destination,
        codeEmpreinte: empreinte(code, sel),
        codeSel: sel,
        maxTentatives: politique.maxTentatives,
        expireA,
        livraison: LIVRAISON.EN_ATTENTE,
        ipDemande: params.ip ?? null,
      },
      select: { id: true },
    });
  });

  // La livraison est CONSTATÉE, jamais supposée : c'est ce qui distingue cette
  // implémentation de l'ancienne, qui répondait « envoyé avec succès » alors
  // que rien ne partait pour un destinataire sans compte Alanya.
  const remise = await livrer(canal, destination, code, politique.dureeSecondes / 60, compte.userId);

  await prisma.verification.update({
    where: { id: ligne.id },
    data: {
      livraison: remise.remis ? LIVRAISON.REMIS : LIVRAISON.ECHEC,
      livraisonDetail: remise.detail ?? null,
    },
  });

  if (!remise.remis) {
    return { ok: false, motif: "NON_REMIS", detail: remise.detail };
  }
  return { ok: true, id: ligne.id, expireA, canal };
}

/** Livre le code sur le canal demandé. Le code ne quitte jamais cette fonction. */
async function livrer(
  canal: string,
  destination: string,
  code: string,
  dureeMinutes: number,
  expediteurId: string,
): Promise<{ remis: boolean; detail?: string }> {
  if (canal === CANAL.EMAIL) {
    return sendOtpEmail(destination, code, Math.round(dureeMinutes));
  }

  // Canal Alanya : message dans la conversation directe avec le destinataire.
  const destinataire = await prisma.user.findFirst({
    where: { OR: [{ publicNumber: destination }, { mobile: destination }] },
    select: { id: true },
  });
  if (!destinataire) {
    // ⚠️ ÉCHEC EXPLICITE, et c'est le cœur du défaut corrigé. L'ancienne route
    // enfermait l'envoi dans un `if (recipient)` et répondait quand même
    // « Code OTP généré et envoyé avec succès » : le développeur croyait le
    // code parti, l'utilisateur attendait indéfiniment, et rien ne le signalait.
    return { remis: false, detail: "Aucun compte Alanya pour cette destination" };
  }
  if (destinataire.id === expediteurId) {
    return { remis: false, detail: "Destination identique à l'expéditeur" };
  }

  try {
    const conv = await findOrCreateDirectConversation(expediteurId, destinataire.id);
    const texte = `Votre code de vérification Alanya est : ${code}. Il expire dans ${Math.round(dureeMinutes)} minutes.`;

    await prisma.message.create({
      data: { convId: conv.id, senderId: expediteurId, content: texte, type: "TEXT", status: "SENT" },
    });

    /*
     * ⚠️ LE DERNIER MESSAGE DE LA CONVERSATION EST MIS À JOUR, ce que l'ancienne
     * route omettait : la conversation ne remontait pas dans la liste et
     * l'aperçu restait sur le message précédent. C'est la même colonne que
     * celle corrigée le 18/08/2026 pour les médias.
     *
     * Le libellé ne contient PAS le code. Il apparaîtrait sinon dans la liste
     * des conversations et dans la notification poussée — donc sur un écran
     * verrouillé, ce qui annule l'intérêt d'un second facteur.
     */
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessage: "🔐 Code de vérification",
        lastMessageAt: new Date(),
        lastMessageSenderID: expediteurId,
        lastMessageType: 0,
        lastMessageStatus: 0,
      },
    });

    return { remis: true };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[verification] livraison Alanya :", detail);
    return { remis: false, detail: detail.slice(0, 255) };
  }
}

export type ResultatVerification =
  | { ok: true }
  | { ok: false; motif: string; essaisRestants: number };

/**
 * Vérifie un code présenté.
 *
 * 🔴 LE MOTIF PRÉCIS RESTE CÔTÉ SERVEUR. L'appelant reçoit un refus unique :
 * distinguer « expiré » de « faux » apprendrait à un attaquant qu'il visait le
 * bon code, et distinguer « inconnu » de « faux » permettrait d'énumérer les
 * destinations.
 *
 * ⚠️ LA TENTATIVE EST COMPTÉE AVANT LA COMPARAISON, et par un incrément
 * atomique en base. Compter après, ou en lisant puis écrivant, laisserait des
 * requêtes concurrentes consommer un seul essai à plusieurs — c'est-à-dire
 * rendre le plafond contournable par la parallélisation, qui est précisément la
 * façon dont on force un code à six chiffres.
 */
export async function verifierCode(params: {
  developerId: string;
  finalite: string;
  destination: string;
  code: string;
}): Promise<ResultatVerification> {
  const { developerId, finalite, destination, code } = params;

  const ligne = await prisma.verification.findFirst({
    where: {
      developerId,
      finalite,
      destination,
      consommeA: null,
      livraison: { not: LIVRAISON.REMPLACE },
    },
    orderBy: { createdAt: "desc" },
  });

  const refus = motifDeRefus(ligne, new Date());
  if (refus !== null) {
    return { ok: false, motif: refus, essaisRestants: 0 };
  }

  const maj = await prisma.verification.update({
    where: { id: ligne!.id },
    data: { tentatives: { increment: 1 } },
    select: { tentatives: true, maxTentatives: true },
  });

  if (!memeEmpreinte(ligne!.codeEmpreinte, empreinte(code, ligne!.codeSel))) {
    return {
      ok: false,
      motif: "CODE_FAUX",
      essaisRestants: Math.max(0, maj.maxTentatives - maj.tentatives),
    };
  }

  // Usage unique : consommé à la première présentation réussie.
  await prisma.verification.update({
    where: { id: ligne!.id },
    data: { consommeA: new Date() },
  });

  return { ok: true };
}
