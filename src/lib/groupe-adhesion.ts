import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF, donneesRetour } from "@/lib/appartenance.mjs";
import { invaliderConversation } from "@/lib/cache-redis.mjs";
import { estAdminDuGroupe } from "@/lib/groupe-droits.mjs";
import { peutChiffrer } from "@/lib/e2ee-perimetre";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";
import { previensManquants } from "@/lib/e2ee-v2";
import { deposerMessageSysteme, nomPourAvis } from "@/lib/messages-systeme";
import { notifieDecisionGroupe, notifieDemandeGroupe } from "@/lib/push";

/**
 * GROUPES PRIVÉS ET PUBLICS, LIEN ET QR CODE D'UN GROUPE (18/11/2026).
 *
 * Demande du user :
 *   · chaque groupe a un lien https://alanyavox.com/g/<code> et son QR code ;
 *   · groupe PRIVÉ : ouvrir le lien place la personne dans une liste
 *     d'attente ; un admin accepte ou refuse ;
 *   · groupe PUBLIC : pas de liste d'attente, on entre aussitôt ;
 *   · le type se choisit à la création, et les admins le changent dans les
 *     réglages du groupe.
 *
 * Les règles vivent ici ; les routes ne font que les appliquer. SQL :
 * `prisma/manual/2026-11_groupes_acces_lien.sql`.
 *
 * Décisions prises en l'écrivant :
 *   · 🔴 UN MEMBRE RETIRÉ PAR UN ADMIN PASSE PAR LA LISTE D'ATTENTE, MÊME DANS
 *     UN GROUPE PUBLIC. Sinon le lien annulerait l'exclusion : un admin le
 *     retire, il revient aussitôt. C'est la règle de `members` (un simple
 *     membre ne réintègre pas un exclu), appliquée au lien.
 *   · Partager le lien, c'est ajouter des membres : ceux qui peuvent ajouter
 *     le voient (les admins, ou tout le monde si le groupe a levé « seuls les
 *     admins ajoutent »). Seul un admin le renouvelle.
 *   · Celui qui entre par le lien l'a choisi : pas de bannière « Rester /
 *     Quitter », contrairement à quelqu'un qu'on a ajouté.
 *   · Groupe chiffré : on n'entre (ni ne demande) que si l'on peut lire,
 *     mêmes refus que l'ajout par un membre (`HORS_PERIMETRE`,
 *     `CLES_MANQUANTES`).
 */

export const ACCES_GROUPE = ["prive", "public"] as const;
export type AccesGroupe = (typeof ACCES_GROUPE)[number];

/** Forme d'un code : base64url, 22 caractères émis, VARCHAR(43) en base. */
export const CODE_LIEN_REGEX = /^[A-Za-z0-9_-]{16,43}$/;

/** 128 bits : deviner le lien d'un groupe est hors de portée. */
export function nouveauCodeLien(): string {
  return randomBytes(16).toString("base64url");
}

/** Même hôte que les QR de profil et que le manifeste Android. */
export function lienGroupe(code: string): string {
  return `https://alanyavox.com/g/${code}`;
}

type ParticipantDroits = { userId: string; role: string; estMembre?: boolean };
type ConvDroits = { adminsSeulsAjoutent: boolean };

/** Voit-il (et partage-t-il) le lien ? Ceux qui peuvent ajouter des membres. */
export function peutPartagerLien(
  conv: ConvDroits,
  participants: ParticipantDroits[],
  userId: string,
): boolean {
  if (!participants.some((p) => p.userId === userId && p.estMembre !== false)) return false;
  return !conv.adminsSeulsAjoutent || estAdminDuGroupe(participants, userId);
}

/**
 * Le code du lien, créé s'il manque (groupes d'avant le 18/11/2026).
 *
 * ⚠️ `updateMany … codeLien: null` : si deux personnes ouvrent le partage au
 * même instant, une seule écriture passe, et les deux relisent le même code.
 */
export async function codeLienDe(convId: string): Promise<string> {
  await prisma.conversation.updateMany({
    where: { id: convId, codeLien: null },
    data: { codeLien: nouveauCodeLien() },
  });
  const c = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { codeLien: true },
  });
  return c!.codeLien!;
}

/** Un admin renouvelle le lien : l'ancien ne mène plus nulle part. */
export async function renouvelerCodeLien(convId: string): Promise<string> {
  const code = nouveauCodeLien();
  await prisma.conversation.update({ where: { id: convId }, data: { codeLien: code } });
  return code;
}

/* ══════════════════ CHIFFREMENT ══════════════════ */

export type RefusChiffrement = {
  code: "HORS_PERIMETRE" | "CLES_MANQUANTES";
  message: string;
  numeros: string[];
};

/**
 * Dans un groupe chiffré, ces comptes pourraient-ils lire ? `null` si oui.
 * Même règle que l'ajout par un membre (décision du user, 09/10/2026).
 */
export async function refusChiffrement(
  conv: { e2eeActif: boolean },
  comptes: { id: string; publicNumber: string; typeCompte: number | null }[],
): Promise<RefusChiffrement | null> {
  if (!conv.e2eeActif || comptes.length === 0) return null;
  const avecCles = new Set(
    (
      await prisma.e2eeIdentite.findMany({
        where: { userId: { in: comptes.map((u) => u.id) } },
        select: { userId: true },
        distinct: ["userId"],
      })
    ).map((i) => i.userId),
  );
  const horsPerimetre = comptes.filter((u) => !peutChiffrer(u));
  if (horsPerimetre.length > 0) {
    return {
      code: "HORS_PERIMETRE",
      message: "Ce type de compte ne peut pas rejoindre un groupe chiffré.",
      numeros: horsPerimetre.map((u) => u.publicNumber),
    };
  }
  const sansCles = comptes.filter((u) => !avecCles.has(u.id));
  if (sansCles.length > 0) {
    return {
      code: "CLES_MANQUANTES",
      message:
        "Ce groupe est chiffré : la personne doit d'abord ouvrir Alanya sur " +
        "un appareil à jour pour publier ses clés.",
      numeros: sansCles.map((u) => u.publicNumber),
    };
  }
  return null;
}

/* ══════════════════ ENTRER DANS LE GROUPE ══════════════════ */

/**
 * Fait entrer des comptes dans un groupe : réactive les anciens membres,
 * crée les autres. Commun à l'ajout par un membre, à l'entrée par le lien et
 * à la demande acceptée — une règle écrite trois fois finit par diverger.
 *
 * 🔴 UN ANCIEN MEMBRE QUI REVIENT EST RÉACTIVÉ, PAS RECRÉÉ (09/10/2026) : sa
 * ligne existe encore (`est_membre = false`), la recréer violerait l'unicité.
 *
 * Invalide le cache de la conversation AVANT de rendre la main : l'avis
 * système que l'appelant dépose ensuite est diffusé aux membres lus dans ce
 * cache, et les nouveaux venus doivent y être.
 */
export async function integrerMembres(
  conv: { id: string; historiqueCacheNouveaux: boolean },
  userIds: string[],
  opts: { arriveeAConfirmer: boolean },
): Promise<void> {
  if (userIds.length === 0) return;
  const convId = conv.id;
  const anciens = new Set(
    (
      await prisma.participant.findMany({
        where: { convId, userId: { in: userIds }, estMembre: false },
        select: { userId: true },
      })
    ).map((p) => p.userId),
  );
  /*
   * L'ARRIVÉE ET L'HISTORIQUE (01/11/2026) : la bannière « Rester / Quitter »
   * pour qui a été ajouté ; si le groupe cache l'historique aux nouveaux, il
   * ne lit que ce qui s'écrit à partir de maintenant.
   */
  const arrivee = {
    arriveeAConfirmer: opts.arriveeAConfirmer,
    historiqueDepuis: conv.historiqueCacheNouveaux ? new Date() : null,
  };
  await prisma.$transaction([
    prisma.participant.updateMany({
      where: { convId, userId: { in: [...anciens] }, estMembre: false },
      data: { ...donneesRetour(), role: "MEMBER", ...arrivee },
    }),
    prisma.participant.createMany({
      data: userIds
        .filter((id) => !anciens.has(id))
        .map((userId) => ({ convId, userId, role: "MEMBER" as const, ...arrivee })),
    }),
  ]);
  await invaliderConversation(convId);
}

/** Les admins actifs du groupe (avec le repli « premier membre »). */
async function adminsDuGroupe(convId: string): Promise<string[]> {
  const participants = await prisma.participant.findMany({
    where: { convId, ...MEMBRE_ACTIF },
    select: { userId: true, role: true },
    orderBy: { joinedAt: "asc" },
  });
  return participants.filter((p) => estAdminDuGroupe(participants, p.userId)).map((p) => p.userId);
}

/**
 * Sonne chez les admins : la liste d'attente a changé. Trame sans contenu
 * (`invitation_*`, verbe déjà admis par le serveur temps réel) ; le push ne
 * part que pour une NOUVELLE demande.
 */
async function prevenirAdmins(
  convId: string,
  nouvelle: { groupe: string | null; demandeurId: string } | null,
): Promise<void> {
  const admins = await adminsDuGroupe(convId);
  await previensDesPersonnes({
    personnes: admins,
    type: "invitation_groupe_demandes",
    donnees: { convId },
  });
  if (!nouvelle) return;
  const demandeurName = await nomPourAvis(nouvelle.demandeurId);
  for (const adminId of admins) {
    await notifieDemandeGroupe({
      recipientId: adminId,
      convId,
      groupe: nouvelle.groupe,
      demandeurName,
    }).catch(() => {});
  }
}

export type ApercuLien = {
  convId: string;
  nom: string | null;
  description: string | null;
  avatarUrl: string | null;
  membres: number;
  acces: AccesGroupe;
  chiffre: boolean;
  /** Ce que le lien ferait pour CE compte. */
  etat: "membre" | "attente" | "aucun";
};

/** Le groupe derrière un code, ou `null`. */
export async function groupeDuCode(code: string) {
  if (!CODE_LIEN_REGEX.test(code)) return null;
  const conv = await prisma.conversation.findUnique({
    where: { codeLien: code },
    include: { participants: { where: MEMBRE_ACTIF, select: { userId: true, role: true } } },
  });
  return conv?.isGroup ? conv : null;
}

/** Ce que voit un compte connecté qui ouvre le lien, avant de confirmer. */
export async function etatPourCompte(convId: string, userId: string, membres: { userId: string }[]) {
  if (membres.some((m) => m.userId === userId)) return "membre" as const;
  const d = await prisma.demandeAdhesion.findUnique({
    where: { convId_userId: { convId, userId } },
    select: { statut: true },
  });
  return d?.statut === "attente" ? ("attente" as const) : ("aucun" as const);
}

export type ResultatRejoindre =
  | { etat: "membre"; convId: string; deja: boolean }
  | { etat: "attente"; convId: string }
  | { refus: RefusChiffrement };

/**
 * Ouvrir le lien et confirmer : entrer (public), ou demander (privé, ou
 * ancien membre retiré par un admin).
 */
export async function rejoindreParLien(
  conv: NonNullable<Awaited<ReturnType<typeof groupeDuCode>>>,
  userId: string,
): Promise<ResultatRejoindre> {
  const convId = conv.id;
  if (conv.participants.some((p) => p.userId === userId)) {
    return { etat: "membre", convId, deja: true };
  }

  const moi = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, publicNumber: true, typeCompte: true },
  });
  const refus = await refusChiffrement(conv, moi ? [moi] : []);
  if (refus) return { refus };

  const ancienne = await prisma.participant.findUnique({
    where: { convId_userId: { convId, userId } },
    select: { excluPar: true },
  });
  const exclu = ancienne?.excluPar != null;

  if (conv.acces === "public" && !exclu) {
    await integrerMembres(conv, [userId], { arriveeAConfirmer: false });
    // Une demande restée en attente n'a plus d'objet.
    await prisma.demandeAdhesion.updateMany({
      where: { convId, userId, statut: "attente" },
      data: { statut: "acceptee", traiteeLe: new Date() },
    });
    await deposerMessageSysteme(convId, userId, "member_joined_link", {
      target: await nomPourAvis(userId),
    });
    if (conv.e2eeActif) await previensManquants(convId);
    return { etat: "membre", convId, deja: false };
  }

  const deja = await prisma.demandeAdhesion.findUnique({
    where: { convId_userId: { convId, userId } },
    select: { statut: true },
  });
  if (deja?.statut === "attente") return { etat: "attente", convId };
  await prisma.demandeAdhesion.upsert({
    where: { convId_userId: { convId, userId } },
    create: { convId, userId },
    update: { statut: "attente", creeLe: new Date(), traiteePar: null, traiteeLe: null },
  });
  await prevenirAdmins(convId, { groupe: conv.name, demandeurId: userId });
  return { etat: "attente", convId };
}

/** Le demandeur retire sa demande. Rend `false` s'il n'y en avait pas. */
export async function annulerDemande(convId: string, userId: string): Promise<boolean> {
  const r = await prisma.demandeAdhesion.deleteMany({
    where: { convId, userId, statut: "attente" },
  });
  if (r.count > 0) await prevenirAdmins(convId, null);
  return r.count > 0;
}

export type ResultatDecision =
  | { ok: true; statut: "acceptee" | "refusee" }
  | { ok: false; code: "NOT_FOUND" | "DEJA_TRAITEE" }
  | { ok: false; refus: RefusChiffrement };

/**
 * Un admin accepte ou refuse une demande. Le contrôle « est-il admin ? » est
 * fait par la route.
 */
export async function deciderDemande(
  conv: { id: string; name: string | null; e2eeActif: boolean; historiqueCacheNouveaux: boolean },
  demandeId: string,
  adminId: string,
  accepter: boolean,
): Promise<ResultatDecision> {
  const convId = conv.id;
  const d = await prisma.demandeAdhesion.findFirst({
    where: { id: demandeId, convId },
    include: { user: { select: { id: true, publicNumber: true, typeCompte: true } } },
  });
  if (!d) return { ok: false, code: "NOT_FOUND" };
  if (d.statut !== "attente") return { ok: false, code: "DEJA_TRAITEE" };

  if (accepter) {
    const refus = await refusChiffrement(conv, [d.user]);
    if (refus) return { ok: false, refus };
  }

  /*
   * ⚠️ LA DEMANDE EST MARQUÉE D'ABORD, ET SEULEMENT SI ELLE ATTEND ENCORE :
   * deux admins qui acceptent au même instant ne font pas entrer la personne
   * deux fois (ni ne déposent deux avis).
   */
  const statut = accepter ? "acceptee" : "refusee";
  const pris = await prisma.demandeAdhesion.updateMany({
    where: { id: demandeId, statut: "attente" },
    data: { statut, traiteePar: adminId, traiteeLe: new Date() },
  });
  if (pris.count === 0) return { ok: false, code: "DEJA_TRAITEE" };

  if (accepter) {
    const dejaMembre = await prisma.participant.findFirst({
      where: { convId, userId: d.userId, ...MEMBRE_ACTIF },
      select: { id: true },
    });
    if (!dejaMembre) {
      await integrerMembres(conv, [d.userId], { arriveeAConfirmer: false });
      await deposerMessageSysteme(convId, adminId, "member_joined_link", {
        target: await nomPourAvis(d.userId),
        actor: await nomPourAvis(adminId),
      });
      if (conv.e2eeActif) await previensManquants(convId);
    }
  }

  // Les autres admins retirent la ligne de leur liste ; le demandeur apprend
  // la réponse (trame pour un écran ouvert, push sinon).
  await prevenirAdmins(convId, null);
  await previensDesPersonnes({
    personnes: [d.userId],
    type: "invitation_groupe_decision",
    donnees: { convId, accepte: accepter },
  });
  await notifieDecisionGroupe({
    recipientId: d.userId,
    convId,
    groupe: conv.name,
    accepte: accepter,
  }).catch(() => {});

  return { ok: true, statut };
}
