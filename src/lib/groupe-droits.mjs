import { MEMBRE_ACTIF } from "./appartenance.mjs";

/**
 * LES DROITS DANS UN GROUPE (01/11/2026, repris du dépôt de référence
 * Alanya2026 — `group_permissions.dart`, `groupAuth.js`).
 *
 * En `.mjs` parce que `ws-server.mjs` en a besoin autant que les routes : une
 * règle écrite deux fois finit toujours par diverger.
 *
 * 🔴 LE PROPRIÉTAIRE N'EST PAS UN RÔLE, C'EST UNE DÉSIGNATION
 * (`conversation.proprietaire_id`). Il garde le rôle ADMIN : les applications
 * déjà installées, qui ne connaissent que ADMIN et MEMBER, continuent de le
 * voir administrateur — c'est d'elles que dépend, entre autres, le
 * renouvellement des clés d'un groupe chiffré. Un rôle OWNER les aurait
 * laissées sans aucun administrateur.
 */

/**
 * Est-il administrateur ? Avec le repli historique : un groupe SANS AUCUN
 * administrateur (créé avant les rôles) fait du premier membre son admin.
 * Les anciens membres sont écartés : un admin parti n'est plus admin.
 *
 * @param {{ userId: string, role: string, estMembre?: boolean }[]} tous
 * @param {string} userId
 */
export function estAdminDuGroupe(tous, userId) {
  const participants = tous.filter((p) => p.estMembre !== false);
  const moi = participants.find((p) => p.userId === userId);
  if (!moi) return false;
  if (moi.role === "ADMIN") return true;
  const aUnAdmin = participants.some((p) => p.role === "ADMIN");
  return !aUnAdmin && participants[0]?.userId === userId;
}

/**
 * Le propriétaire effectif : celui que désigne la conversation, s'il en est
 * encore membre. `null` pour un groupe sans propriétaire (créé avant le
 * 01/11/2026 et pas encore rattrapé) — les règles d'avant s'appliquent alors.
 *
 * @param {{ proprietaireId?: string | null }} conv
 * @param {{ userId: string, estMembre?: boolean }[]} participants
 */
export function proprietaireEffectif(conv, participants) {
  const id = conv.proprietaireId ?? null;
  if (!id) return null;
  return participants.some((p) => p.userId === id && p.estMembre !== false) ? id : null;
}

/** Le refus d'écrire dans un groupe en mode annonce. */
export const ADMINS_SEULS = "ADMINS_SEULS";

/**
 * MODE ANNONCE : dans un groupe où seuls les admins écrivent, rend
 * `ADMINS_SEULS` pour un simple membre, `null` sinon.
 *
 * ⚠️ LES AVIS SYSTÈME NE PASSENT PAS PAR ICI (`deposerMessageSysteme` écrit
 * directement) : « X a quitté le groupe » reste annoncé.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} convId
 * @param {string} userId
 */
export async function refusAnnonce(prisma, convId, userId) {
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: {
      isGroup: true,
      adminsSeulsEcrivent: true,
      participants: {
        where: MEMBRE_ACTIF,
        select: { userId: true, role: true },
        orderBy: { joinedAt: "asc" },
      },
    },
  });
  if (!conv?.isGroup || !conv.adminsSeulsEcrivent) return null;
  return estAdminDuGroupe(conv.participants, userId) ? null : ADMINS_SEULS;
}

/**
 * CE MEMBRE EST-IL EN SOURDINE POUR CE MESSAGE ? (01/11/2026)
 *
 *  - `sourdine = 1` : pour toujours (le réglage d'avant) ;
 *  - `sourdineJusqua` dans le futur : pour un temps (8 h, une semaine) ;
 *  - « mentions seulement », en groupe : prévenu quand on le cite, et
 *    seulement alors.
 *
 * ⚠️ LA SOURDINE NE COUPE QUE LA NOTIFICATION, jamais la diffusion en temps
 * réel : être en sourdine, c'est ne pas être dérangé, pas cesser de recevoir.
 *
 * @param {{ sourdine?: number, sourdineJusqua?: Date | null, mentionsSeulement?: boolean }} p
 * @param {{ mentionne: boolean, enGroupe: boolean, maintenant?: Date }} contexte
 */
export function enSourdinePour(p, { mentionne, enGroupe, maintenant = new Date() }) {
  if (p.sourdine === 1) return true;
  if (p.sourdineJusqua && new Date(p.sourdineJusqua) > maintenant) return true;
  if (enGroupe && p.mentionsSeulement === true && !mentionne) return true;
  return false;
}

/**
 * LE PROPRIÉTAIRE S'EN VA : la propriété passe à l'admin le plus ancien, sinon
 * au membre le plus ancien — qui devient admin. Un groupe n'est jamais laissé
 * sans responsable.
 *
 * À appeler APRÈS avoir marqué le départ. Ne fait rien si le partant n'était
 * pas le propriétaire, ou s'il ne reste personne.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} convId
 * @param {string} partantId
 */
export async function transmettrePropriete(prisma, convId, partantId) {
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { proprietaireId: true },
  });
  if (conv?.proprietaireId !== partantId) return null;
  const restants = await prisma.participant.findMany({
    where: { convId, ...MEMBRE_ACTIF, userId: { not: partantId } },
    select: { userId: true, role: true },
    orderBy: { joinedAt: "asc" },
  });
  const heritier = restants.find((p) => p.role === "ADMIN") ?? restants[0];
  if (!heritier) {
    await prisma.conversation.update({ where: { id: convId }, data: { proprietaireId: null } });
    return null;
  }
  await prisma.$transaction([
    prisma.participant.update({
      where: { convId_userId: { convId, userId: heritier.userId } },
      data: { role: "ADMIN" },
    }),
    prisma.conversation.update({
      where: { id: convId },
      data: { proprietaireId: heritier.userId },
    }),
  ]);
  return heritier.userId;
}
