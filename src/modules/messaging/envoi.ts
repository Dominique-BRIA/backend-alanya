import { prisma } from "@/lib/prisma";
import { apercuMessage } from "@/lib/message-payload.mjs";

/**
 * LE CŒUR D'ENVOI D'UN MESSAGE — partagé par la route de conversation et par
 * l'API v1.
 *
 * 🔴 POURQUOI IL EXISTE. `POST /api/v1/messages/send` avait sa propre copie de
 * cette séquence, et elle en avait perdu QUATRE morceaux en chemin :
 *
 * 1. **Aucun contrôle de blocage.** Un porteur de clé pouvait écrire à
 *    quelqu'un qui l'avait bloqué — ce que le client refuse, ce que le
 *    WebSocket refuse, et ce que la route HTTP refuse aussi. L'API était la
 *    seule porte restée ouverte.
 * 2. **Les messages éphémères étaient ignorés** : `expiresAt` n'était jamais
 *    posé, donc un message envoyé par l'API dans une conversation à
 *    effacement automatique y restait pour toujours.
 * 3. **Les médias étaient liés à la main** (`mediaFile.create` avec une taille
 *    inventée) au lieu de la relation `media: { connect: … }`.
 * 4. **`lastMessageType` et `lastMessageStatus` n'étaient pas écrits**, alors
 *    que les trois clients s'en servent pour l'icône de la liste.
 *
 * Une copie perd toujours quelque chose. Celle-ci en avait perdu quatre choses
 * en un seul fichier — d'où cette fonction, qui est désormais **le seul endroit
 * où un message naît** hors du WebSocket et du transfert.
 */

/** Les types qu'un appelant peut créer. `SYSTEM` est réservé au serveur. */
export type TypeMessage =
  | "TEXT"
  | "IMAGE"
  | "FILE"
  | "AUDIO"
  | "VIDEO"
  | "CONTACT"
  | "LOCATION";

export type ResultatEnvoi =
  | { ok: true; message: Awaited<ReturnType<typeof creerLigneMessage>> }
  | { ok: false; motif: "BLOQUE" | "MEDIA_ETRANGER" };

/** Isolée pour que `ResultatEnvoi` puisse en déduire le type de retour exact. */
function creerLigneMessage(data: Parameters<typeof prisma.message.create>[0]["data"]) {
  return prisma.message.create({ data, include: { media: true } });
}

/**
 * Crée un message, met à jour la conversation et les compteurs de non-lus.
 *
 * Ne notifie personne : la diffusion temps réel appartient au WebSocket et la
 * notification poussée à l'appelant qui en a besoin (l'API v1 en a besoin, la
 * route de conversation non — son client est déjà à l'écran).
 */
export async function creerMessage(params: {
  convId: string;
  expediteurId: string;
  type: TypeMessage;
  content?: string | null;
  mediaId?: string;
  mediaIds?: string[];
  replyToId?: string;
}): Promise<ResultatEnvoi> {
  const { convId, expediteurId, type, replyToId } = params;
  const content = params.content ?? null;

  /*
   * Blocage. On répond par un refus, jamais par un faux succès : mentir à
   * l'appelant n'est pas le rôle de l'API. Le contrôle ne vaut que pour un
   * tête-à-tête — dans un groupe, un blocage entre deux membres ne retire la
   * parole à personne.
   */
  const participants = await prisma.participant.findMany({
    where: { convId },
    select: { userId: true },
  });
  if (participants.length === 2) {
    const autre = participants.find((p) => p.userId !== expediteurId)?.userId;
    if (autre) {
      const blocage = await prisma.blocked.findFirst({
        where: {
          OR: [
            { alanyaID: expediteurId, idCallerBlock: autre },
            { alanyaID: autre, idCallerBlock: expediteurId },
          ],
        },
        select: { idBlock: true },
      });
      if (blocage) return { ok: false, motif: "BLOQUE" };
    }
  }

  /*
   * ⚠️ LES MÉDIAS DOIVENT APPARTENIR À L'EXPÉDITEUR.
   *
   * `media: { connect: { id } }` accepte n'importe quel identifiant existant :
   * sans ce contrôle, connaître l'UUID d'un fichier suffit à le rattacher à son
   * propre message, donc à le faire lire par le contrôle d'accès de
   * `/api/media/:id` — qui autorise les participants du message porteur.
   * Un identifiant n'est pas un secret ; c'est la propriété qui l'est.
   *
   * (Le TRANSFERT de message ne passe pas par ici : il recopie légitimement le
   * média d'autrui et garde son propre chemin.)
   */
  const idsMedias = params.mediaIds?.length ? params.mediaIds : params.mediaId ? [params.mediaId] : [];
  if (idsMedias.length > 0) {
    const possedes = await prisma.mediaFile.count({
      where: { id: { in: idsMedias }, ownerId: expediteurId },
    });
    if (possedes !== idsMedias.length) return { ok: false, motif: "MEDIA_ETRANGER" };
  }

  // Messages éphémères : l'expiration suit le réglage de la conversation.
  const convCfg = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { disappearingSeconds: true },
  });
  const ttl = convCfg?.disappearingSeconds ?? 0;
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

  const message = await creerLigneMessage({
    convId,
    senderId: expediteurId,
    content,
    type,
    replyToId,
    status: "SENT",
    expiresAt,
    ...(idsMedias.length > 0 ? { media: { connect: idsMedias.map((id) => ({ id })) } } : {}),
  });

  /*
   * `lastMessage` reçoit le LIBELLÉ, jamais la charge utile.
   *
   * Un CONTACT ou une LOCATION porte du JSON dans `content` ; l'y recopier
   * afficherait `{"v":1,…}` sous le nom du correspondant. Et `apercuStructure`
   * seul laissait la colonne à NULL pour un média sans légende, ce qui faisait
   * basculer la liste sur l'aperçu du dernier APPEL (défaut mesuré en
   * production le 18/08/2026). `apercuMessage` couvre les deux cas.
   */
  await prisma.conversation.update({
    where: { id: convId },
    data: {
      lastMessage: apercuMessage(type, content)?.slice(0, 500) ?? null,
      lastMessageAt: new Date(),
      lastMessageSenderID: expediteurId,
      lastMessageType:
        type === "TEXT" ? 0 : type === "IMAGE" ? 1 : type === "AUDIO" ? 3 : type === "VIDEO" ? 4 : 2,
      lastMessageStatus: 0,
    },
  });

  await prisma.participant.updateMany({
    where: { convId, userId: { not: expediteurId } },
    data: { unreadCount: { increment: 1 } },
  });

  return { ok: true, message };
}

/** Sérialisation d'un message et de ses médias, commune aux deux routes. */
export function serialiserMessage(message: Awaited<ReturnType<typeof creerLigneMessage>>) {
  return {
    id: message.id,
    convId: message.convId,
    senderId: message.senderId,
    content: message.content,
    type: message.type,
    status: message.status,
    replyToId: message.replyToId,
    media: message.media.map((f) => ({
      id: f.id,
      // L'URL de lecture reste proxyfiée par le backend : c'est elle qui porte
      // le contrôle d'accès, quel que soit le stockage derrière.
      url: `/api/media/${f.id}`,
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      durationMs: f.durationMs,
    })),
    createdAt: message.createdAt,
  };
}
