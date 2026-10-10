import { Prisma, type EnvoiMorceaux } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { HttpError } from "@/lib/http";
import { MEMBRE_ACTIF, membresActifs } from "@/lib/appartenance.mjs";
import { idMessageClient, lireChargeGroupe, type ChargeGroupe } from "@/lib/e2ee-groupe-charge";
import { annoncerMessageChiffre } from "@/lib/e2ee-annonce";
import { creerMessage } from "@/modules/messaging/envoi";
import {
  ENVELOPPES_MAX,
  blocageAvec,
  deposerEnveloppes,
  destinataireEtranger,
  lireEnveloppes,
  type EnveloppeLue,
} from "@/modules/e2ee/enveloppes";

// =============================================================================
// LA PUBLICATION DIFFÉRÉE D'UN ENVOI EN MORCEAUX (10/10/2026, lot 1b).
// =============================================================================
//
// 🔴 LE PROBLÈME. Application fermée, Android finit d'envoyer les morceaux…
// et plus personne n'est là pour poster le message. Le fichier arrive, la
// conversation n'en sait rien.
//
// 🔴 LA RÉPONSE. L'appareil prépare TOUT au premier plan, pendant que
// l'utilisateur regarde encore l'écran : l'identifiant du message, le
// descripteur chiffré (qui cite le média par l'identifiant de l'envoi, connu
// dès la réservation), puis les enveloppes Signal — ou le chiffré du groupe.
// Il confie le paquet au serveur (`POST …/envois/:id/publication`). Le
// serveur, qui ne peut rien en lire, le publie à l'instant où le dernier
// morceau est assemblé : `creerMessage`, dépôt des enveloppes, sonnette et
// notification — exactement ce que l'appareil aurait fait lui-même.
//
// ⚠️ LE CHIFFREMENT RESTE SUR L'APPAREIL ET AU PREMIER PLAN. Faire tourner la
// pile Signal dans une tâche de fond, c'est risquer deux cliquets qui avancent
// en même temps sur la même session. Ici, rien de cryptographique ne se passe
// après la préparation : le serveur ne fait que poser des octets opaques.
//
// ⚠️ FILS CHIFFRÉS SEULEMENT, pour l'instant. Un message en clair créé par
// REST ne prévient personne en temps réel (le pont n'accepte que les trames
// `e2ee_*`) : le publier ici le ferait arriver sans bruit. Lot 4.
//
// ⚠️ LES CONTRÔLES ONT LIEU DEUX FOIS. À la programmation, pour refuser tout
// de suite ce qui ne passera jamais ; à la publication, parce que des heures
// ont pu s'écouler — blocage, clé de groupe changée, message cité supprimé.
// Un refus à la publication n'efface rien : le média reste, l'état le dit
// (`refus:<MOTIF>`), et l'appareil, à sa prochaine ouverture, renvoie le
// message par le chemin ordinaire avec ce média.
// =============================================================================

const TYPES = new Set(["IMAGE", "VIDEO", "AUDIO", "FILE"] as const);
type TypeMedia = "IMAGE" | "VIDEO" | "AUDIO" | "FILE";

/** Ce que l'appareil a préparé, tel qu'on le garde jusqu'à la publication. */
interface PublicationPreparee {
  convId: string;
  type: TypeMedia;
  messageId: string;
  replyToId?: string;
  vueUnique?: boolean;
  /** Fil à deux : l'appareil expéditeur et ses enveloppes. */
  deviceId?: number;
  enveloppes?: EnveloppeLue[];
  /** Groupe chiffré : le chiffré unique du message. */
  groupe?: ChargeGroupe;
}

export interface EtatPublication {
  etat: string | null;
  messageId: string | null;
}

const etatDe = (e: Pick<EnvoiMorceaux, "publicationEtat" | "messageId">): EtatPublication => ({
  etat: e.publicationEtat,
  messageId: e.messageId,
});

/**
 * Enregistre le message à publier quand le fichier sera arrivé. Lève une
 * `HttpError` pour tout ce qui ne pourra jamais passer.
 */
export async function programmerPublication(
  envoi: EnvoiMorceaux,
  userId: string,
  brut: unknown,
): Promise<EtatPublication> {
  const r = (brut ?? {}) as Record<string, unknown>;
  const messageId = idMessageClient(r.messageId);
  if (!messageId) {
    throw new HttpError(400, "« messageId » (UUID v4 tiré par l'appareil) est requis", "BAD_BODY");
  }

  /*
   * ⚠️ IDEMPOTENT POUR LE MÊME MESSAGE. La réponse a pu se perdre : l'appareil
   * reprogramme, et doit retrouver ce qu'il avait programmé. Un AUTRE message
   * sur le même envoi, en revanche, est une erreur : un fichier, un message.
   */
  if (envoi.publicationEtat !== null) {
    const precedent = (envoi.publication as { messageId?: string } | null)?.messageId ?? envoi.messageId;
    if (precedent === messageId) return etatDe(envoi);
    throw new HttpError(409, "Une publication est déjà programmée pour cet envoi", "PUBLICATION_DEJA_PROGRAMMEE");
  }

  if (!envoi.chiffre) {
    throw new HttpError(422, "La publication différée ne vaut que pour un fichier chiffré", "PUBLICATION_EN_CLAIR");
  }
  if (typeof r.convId !== "string" || r.convId === "") {
    throw new HttpError(400, "« convId » est requis", "BAD_BODY");
  }
  const convId = r.convId;
  if (typeof r.type !== "string" || !TYPES.has(r.type as TypeMedia)) {
    throw new HttpError(400, "« type » : IMAGE, VIDEO, AUDIO ou FILE", "BAD_BODY");
  }
  const type = r.type as TypeMedia;
  if (r.replyToId !== undefined && (typeof r.replyToId !== "string" || r.replyToId === "")) {
    throw new HttpError(400, "« replyToId » invalide", "BAD_BODY");
  }

  const membre = await prisma.participant.findFirst({
    where: { convId, userId, ...MEMBRE_ACTIF },
    select: { id: true },
  });
  if (!membre) throw new HttpError(404, "Conversation inconnue", "NOT_FOUND");

  const fil = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { e2eeActif: true, isGroup: true },
  });
  if (fil?.e2eeActif !== true) {
    throw new HttpError(409, "Cette conversation n'est pas chiffrée", "CONVERSATION_NON_CHIFFREE");
  }

  const deja = await prisma.message.findUnique({ where: { id: messageId }, select: { id: true } });
  if (deja) throw new HttpError(409, "Cet identifiant de message est déjà pris", "ID_DEJA_PRIS");

  const preparee: PublicationPreparee = {
    convId,
    type,
    messageId,
    ...(typeof r.replyToId === "string" ? { replyToId: r.replyToId } : {}),
    ...(r.vueUnique === true ? { vueUnique: true } : {}),
  };

  if (fil.isGroup === true) {
    // Groupe : un seul chiffré, écrit avec la ligne. Aucune enveloppe.
    if (r.enveloppes !== undefined) {
      throw new HttpError(400, "En groupe, le message ne porte pas d'enveloppes", "BAD_BODY");
    }
    const groupe = lireChargeGroupe(r.groupe);
    if (!groupe) throw new HttpError(400, "Charge de groupe chiffrée absente ou mal formée", "CHARGE_GROUPE_INVALIDE");
    preparee.groupe = groupe;
  } else {
    if (r.groupe !== undefined) {
      throw new HttpError(400, "Charge de groupe hors d'un groupe", "CHARGE_GROUPE_INVALIDE");
    }
    if (typeof r.deviceId !== "number" || !Number.isInteger(r.deviceId)) {
      throw new HttpError(400, "« deviceId » de l'expéditeur est requis", "BAD_BODY");
    }
    // Mêmes règles que `POST /api/e2ee/enveloppes`.
    const lues = lireEnveloppes(r.enveloppes);
    if (lues === "AUCUNE") throw new HttpError(400, "Aucune enveloppe", "BAD_BODY");
    if (lues === "TROP") throw new HttpError(400, `Pas plus de ${ENVELOPPES_MAX} enveloppes`, "TOO_MANY");
    if (lues === "MAL_FORMEE") throw new HttpError(400, "Une enveloppe est mal formée", "BAD_BODY");
    if (await destinataireEtranger(convId, lues)) {
      throw new HttpError(403, "Destinataire hors de la conversation", "FORBIDDEN");
    }
    if (await blocageAvec(userId, lues)) {
      throw new HttpError(403, "Message non distribuable", "BLOCKED");
    }
    preparee.deviceId = r.deviceId;
    preparee.enveloppes = lues;
  }

  const apres = await prisma.envoiMorceaux.update({
    where: { id: envoi.id },
    data: {
      publication: preparee as unknown as Prisma.InputJsonValue,
      publicationEtat: "attente",
      majLe: new Date(),
    },
  });

  // Le fichier était déjà là (petit fichier, réseau rapide) : on publie tout de suite.
  if (apres.statut === "termine") return publierSiProgramme(envoi.id);
  return etatDe(apres);
}

/**
 * Publie le message programmé, si le fichier est assemblé et que personne ne
 * l'a déjà fait. NE LÈVE JAMAIS : elle est appelée par le morceau qui termine
 * l'envoi, et un refus de publication ne doit pas faire croire à Android que
 * son morceau est perdu (il le renverrait en boucle).
 *
 * 🔴 UNE SEULE PUBLICATION. Même garde que l'assemblage : le passage
 * `attente → en_cours` est une écriture conditionnelle, la base n'en laisse
 * passer qu'une.
 */
export async function publierSiProgramme(envoiId: string): Promise<EtatPublication> {
  const pris = await prisma.envoiMorceaux.updateMany({
    where: { id: envoiId, statut: "termine", publicationEtat: "attente" },
    data: { publicationEtat: "en_cours" },
  });
  const envoi = await prisma.envoiMorceaux.findUnique({ where: { id: envoiId } });
  if (!envoi) return { etat: null, messageId: null };
  if (pris.count === 0) return etatDe(envoi);

  const p = envoi.publication as unknown as PublicationPreparee;
  const fixer = (data: Prisma.EnvoiMorceauxUpdateInput) =>
    prisma.envoiMorceaux.update({ where: { id: envoiId }, data }).then(etatDe);

  let messageCree: string | null = null;
  try {
    const r = await creerMessage({
      convId: p.convId,
      expediteurId: envoi.ownerId,
      type: p.type,
      // Le média porte l'identifiant de l'envoi : c'est celui que le
      // descripteur chiffré cite déjà.
      mediaId: envoi.mediaId ?? envoi.id,
      replyToId: p.replyToId,
      chiffre: true,
      vueUnique: p.vueUnique === true,
      groupe: p.groupe,
      id: p.messageId,
    });
    if (!r.ok) return await fixer({ publicationEtat: `refus:${r.motif}` });
    messageCree = r.message.id;

    if (p.groupe) {
      await annoncerMessageChiffre({
        convId: p.convId,
        expediteurId: envoi.ownerId,
        messageId: messageCree,
        personnes: await membresActifs(prisma, p.convId),
        extra: { groupe: true },
      });
    } else {
      /*
       * ⚠️ SEULEMENT LES MEMBRES D'AUJOURD'HUI. Le paquet a été préparé il y a
       * peut-être des heures : un destinataire qui a quitté le fil entre-temps
       * ne reçoit pas son enveloppe.
       */
      const membres = new Set(await membresActifs(prisma, p.convId));
      const lues = (p.enveloppes ?? []).filter((e) => membres.has(e.destinataireId));
      await deposerEnveloppes({
        convId: p.convId,
        expediteurId: envoi.ownerId,
        expediteurDevice: p.deviceId!,
        messageId: messageCree,
        lues,
      });
      await annoncerMessageChiffre({
        convId: p.convId,
        expediteurId: envoi.ownerId,
        messageId: messageCree,
        personnes: lues.map((e) => e.destinataireId),
      });
    }

    // Les enveloppes sont déposées : inutile de garder leur double ici.
    return await fixer({ publicationEtat: "publie", messageId: messageCree, publication: Prisma.DbNull });
  } catch (err) {
    console.error("[envois] publication différée :", err);
    /*
     * Avant la ligne du message : rien n'est fait, on pourra réessayer
     * (`…/terminer`). Après : le message existe, mais ses enveloppes peut-être
     * pas — on le dit, sans republier (ce serait un doublon).
     */
    return fixer(
      messageCree
        ? { publicationEtat: "refus:DEPOT_IMPOSSIBLE", messageId: messageCree }
        : { publicationEtat: "attente" },
    ).catch(() => etatDe(envoi));
  }
}
