import { MEMBRE_ACTIF } from "./appartenance.mjs";

/**
 * LE COMPTE OFFICIEL « ALANYA WORK » — l'expéditeur des diffusions et du
 * message de bienvenue (console de gestion, 15/10/2026).
 *
 * ── CE QU'IL EST ────────────────────────────────────────────────────────
 *
 * Une ligne de `users` comme une autre, distinguée par `type_compte = 5`. Le
 * 5 n'était pris par personne : ni par nous (0, 2, 3, 4, 9), ni par
 * alanyaCenter qui partage la base (0, 2, 3). Il n'a ni e-mail, ni mobile, ni
 * mot de passe : aucune voie de connexion ne mène à lui.
 *
 * ── CE QUE SON TYPE ENTRAÎNE, SANS UNE LIGNE DE PLUS ────────────────────
 *
 * 🔴 SES CONVERSATIONS NE SONT JAMAIS CHIFFRÉES. Le 5 n'est pas dans la liste
 * blanche de `e2ee-perimetre.ts` : l'activation y répond `HORS_PERIMETRE`. Et
 * c'est indispensable — c'est le SERVEUR qui écrit en son nom, et le serveur
 * ne peut pas écrire dans un fil chiffré (`CONVERSATION_CHIFFREE`). Ne jamais
 * ajouter le 5 à cette liste : diffusions et bienvenue n'arriveraient plus.
 *
 * ── CE QUE CE FICHIER AJOUTE : PERSONNE NE LUI RÉPOND ───────────────────
 *
 * Décision du user : comme les comptes d'entreprise de WhatsApp, on ne peut
 * pas répondre au compte officiel — ni écrire, ni transférer, ni appeler.
 * Personne ne lit ce compte ; une réponse partirait dans le vide.
 *
 * ⚠️ LA GARDE EST ICI, EN `.mjs`, PARCE QU'IL Y A CINQ PORTES : la route
 * HTTP d'envoi (`creerMessage`), l'envoi par le WebSocket, le transfert par
 * l'une et l'autre voie, et la sonnerie d'appel. Le serveur WebSocket est en
 * JavaScript pur et ne peut importer que des `.mjs`. Une règle écrite deux
 * fois finit par diverger — c'est la leçon des trois oublis du répondeur.
 */
export const TYPE_COMPTE_OFFICIEL = 5;

/** Le nom affiché du compte officiel. */
export const NOM_COMPTE_OFFICIEL = "Alanya Work";

/**
 * Cet expéditeur écrit-il au compte officiel dans un fil à deux ? Si oui,
 * l'écriture est refusée. Le compte officiel lui-même passe toujours : c'est
 * lui qui diffuse.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} convId
 * @param {string} expediteurId
 * @returns {Promise<boolean>}
 */
export async function ecritureVersOfficiel(prisma, convId, expediteurId) {
  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: {
      isGroup: true,
      participants: {
        where: MEMBRE_ACTIF,
        select: { userId: true, user: { select: { typeCompte: true } } },
      },
    },
  });
  if (!conv || conv.isGroup) return false;
  const moi = conv.participants.find((p) => p.userId === expediteurId);
  if (moi?.user?.typeCompte === TYPE_COMPTE_OFFICIEL) return false;
  return conv.participants.some(
    (p) => p.userId !== expediteurId && p.user?.typeCompte === TYPE_COMPTE_OFFICIEL,
  );
}

/**
 * Ce compte est-il le compte officiel ?
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function estCompteOfficiel(prisma, userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { typeCompte: true } });
  return u?.typeCompte === TYPE_COMPTE_OFFICIEL;
}

/** Le message que lisent les clients qui ne connaissent pas encore ce refus. */
export const MESSAGE_REFUS_OFFICIEL =
  "Vous ne pouvez pas répondre à ce compte : seul Alanya Work peut y écrire.";
