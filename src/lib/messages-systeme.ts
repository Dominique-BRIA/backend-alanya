import { prisma } from "@/lib/prisma";
import { nomAffichage } from "@/lib/display-name.mjs";

/**
 * Messages système d'un groupe — arrivée, retrait, départ d'un membre.
 *
 * Le texte n'est JAMAIS figé en base. Chaque membre lit l'application dans sa
 * propre langue : une phrase enregistrée en français resterait française pour
 * tout le monde. On enregistre donc un code et ses paramètres, et c'est le
 * client qui compose la phrase.
 *
 * Même format que l'avis de blocage, déjà en service : les deux passent par le
 * même composeur côté client (`src/i18n/messages-systeme.ts`).
 */

/** Codes reconnus par les clients. Ajouter un code demande de les mettre à jour. */
export type CodeSysteme = "member_added" | "member_removed" | "member_left";

/**
 * Dépose un message système dans une conversation.
 *
 * `senderId` porte l'auteur de l'action — celui qui ajoute, qui retire, ou qui
 * part. C'est cohérent avec le reste de la table, et sans effet sur
 * l'alignement : les clients testent le type `SYSTEM` avant de regarder qui
 * envoie, et affichent la bulle centrée.
 *
 * Aucune diffusion temps réel ici : ces routes sont servies par l'API HTTP, qui
 * ne partage pas le processus du serveur WebSocket. Les membres verront l'avis
 * à la prochaine lecture du fil. Les rattacher au temps réel demanderait un
 * pont entre les deux services — à faire séparément, si le délai gêne.
 */
export async function deposerMessageSysteme(
  convId: string,
  auteurId: string,
  code: CodeSysteme,
  parametres: Record<string, string>,
): Promise<void> {
  // ⚠️ NE PAS FAIRE PASSER CETTE CHARGE PAR `tronqueContenu` : elle est du JSON,
  // mais `SYSTEM` n'est pas un type structuré au sens de `message-payload.mjs`,
  // si bien que la fonction la COUPERAIT au lieu de la refuser — et un avis
  // système coupé n'est plus lisible par aucun client.
  //
  // Elle tient sans contrainte dans le VARCHAR(500) de la colonne : les trois
  // codes ne portent que des pseudos, plafonnés à 50 caractères chacun et deux
  // au maximum par avis, soit ~120 caractères en pratique.
  const charge = JSON.stringify({ code, ...parametres });

  await prisma.message.create({
    data: { convId, senderId: auteurId, content: charge, type: "SYSTEM", status: "SENT" },
  });

  // Le dernier message dénormalisé sert la liste des discussions : sans cette
  // mise à jour, la conversation garderait l'aperçu du message précédent et
  // remonterait mal dans le tri.
  await prisma.conversation.update({
    where: { id: convId },
    data: {
      lastMessage: charge.slice(0, 500),
      lastMessageAt: new Date(),
      lastMessageSenderID: auteurId,
      lastMessageType: 2,
      lastMessageStatus: 0,
    },
  });
}

/** Nom affichable d'un utilisateur, pour figer l'identité dans l'avis. */
export async function nomPourAvis(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { pseudo: true, publicNumber: true },
  });
  return u ? nomAffichage(u) : "";
}
