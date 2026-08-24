import { apercuMessage } from "./message-payload.mjs";

/**
 * Le libellé de `conversation.lastMessage` est PLAFONNÉ À 500 caractères.
 *
 * La colonne les accepte, et les trois clients l'affichent sur une ligne : au
 * delà, on transporte un roman pour n'en montrer que le début. Le même plafond
 * est appliqué à l'écriture d'un message (`ws-server.mjs`), c'est lui qu'on
 * reprend ici pour que modifier un message ne produise pas un libellé d'une
 * autre longueur que l'avoir envoyé.
 */
export const APERCU_MAX = 500;

/**
 * Réécrit `conversation.lastMessage` quand le message MODIFIÉ est le dernier de
 * la conversation.
 *
 * 🐛 POURQUOI CETTE FONCTION EXISTE (défaut signalé le 24/08/2026) : « je
 * modifie un message, la liste des conversations continue d'afficher l'ancien
 * texte ». L'édition n'écrivait que la ligne `message` ; or `GET
 * /api/conversations` PRÉFÈRE la colonne dénormalisée au message lui-même
 * (`conv.lastMessage ?? apercuMessage(fallbackLast…)`). Le libellé périmé
 * gagnait donc, et aucun rechargement ne pouvait le corriger — ce n'était pas
 * un défaut d'affichage côté client, mais une donnée jamais mise à jour.
 *
 * ⚠️ `lastMessageAt` n'est VOLONTAIREMENT PAS touché. C'est lui qui ordonne la
 * liste : le rafraîchir ferait remonter la conversation en tête à chaque
 * correction de faute de frappe, y compris sur un message vieux d'une semaine.
 * Modifier n'est pas écrire.
 *
 * ⚠️ Le contrôle « est-ce le dernier ? » reprend EXACTEMENT le critère de
 * lecture de `GET /api/conversations` (`orderBy: createdAt desc, take: 1`, sans
 * filtre sur `deletedAt`). Un critère plus fin ici ferait diverger l'écriture de
 * la lecture, et le libellé retomberait faux dans les cas de bord.
 *
 * @param prisma Le client Prisma de l'appelant — le serveur WS et les routes
 *   HTTP n'instancient pas le même, cette fonction ne doit en connaître aucun.
 * @param message La ligne `message` AVANT modification (pour `convId` et `type`).
 * @param contenu Le nouveau contenu, déjà nettoyé.
 * @returns Le libellé écrit, ou `null` si le message n'était pas le dernier.
 */
export async function rafraichirApercuApresEdition(prisma, message, contenu) {
  const dernier = await prisma.message.findFirst({
    where: { convId: message.convId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (dernier?.id !== message.id) return null;

  const libelle = apercuMessage(message.type, contenu)?.slice(0, APERCU_MAX) ?? null;
  await prisma.conversation.update({
    where: { id: message.convId },
    data: { lastMessage: libelle },
  });
  return libelle;
}
