import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { sendMessageSchema } from "@/lib/validation";
import { MEDIA_ORDONNE } from "@/lib/media-ordre";
import { assertParticipant } from "@/modules/messaging/access";
import { creerMessage, serialiserMessage } from "@/modules/messaging/envoi";

const PAGE_SIZE = 50;

// GET /api/conversations/:id/messages?cursor=<messageId>&limit=50
// Historique paginé (curseur), du plus récent au plus ancien.
export const GET = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  // F10 : remet le compteur de non-lus à 0 quand l'utilisateur ouvre la conversation
  await prisma.participant.update({
    where: { convId_userId: { convId, userId } },
    data: { unreadCount: 0 },
  });

  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? PAGE_SIZE), 100);

  // Réglage « messages éphémères » de la conversation (exposé à l'app).
  const convCfg = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { disappearingSeconds: true },
  });

  // Blocage : masque à la lecture les messages des utilisateurs avec qui je suis
  // bloqué (dans un sens ou l'autre) → le blocage est silencieux et effectif.
  const blockedRows = await prisma.blocked.findMany({
    where: { OR: [{ alanyaID: userId }, { idCallerBlock: userId }] },
    select: { alanyaID: true, idCallerBlock: true },
  });
  const blockedIds = [
    ...new Set(
      blockedRows.map((b) => (b.alanyaID === userId ? b.idCallerBlock : b.alanyaID)),
    ),
  ];

  const messages = await prisma.message.findMany({
    where: {
      convId,
      // On GARDE les messages supprimés (deletedAt != null) pour afficher le
    // placeholder « Ce message a été supprimé ». On EXCLUT seulement les
    // messages que CET utilisateur a masqués (« supprimer pour moi »).
      hides: { none: { userId } },
      // Messages éphémères arrivés à expiration : masqués à la lecture (la purge
      // définitive est faite périodiquement par le serveur WS).
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(blockedIds.length > 0 ? { senderId: { notIn: blockedIds } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      // Sans tri explicite, la grille de photos se réordonne à chaque lecture —
      // voir `src/lib/media-ordre.ts`.
      media: MEDIA_ORDONNE,
      reactions: { select: { userId: true, emoji: true } },
      stars: { where: { userId }, select: { id: true } },
      // Les mentions `@` : sans elles ici, un message relu depuis l'historique
      // perdrait sa mise en évidence — elle n'apparaîtrait que sur les messages
      // arrivés en temps réel, ce qui ressemblerait à un défaut d'affichage.
      mentions: { select: { userId: true, libelle: true } },
    },
  });

  const hasMore = messages.length > limit;
  const page = hasMore ? messages.slice(0, limit) : messages;

  /**
   * Pseudos d'appareil, pour MES propres messages seulement.
   *
   * Le pseudo dit quel appareil du compte a écrit ; il ne regarde que ce
   * compte. On ne le charge donc que pour les messages dont je suis
   * l'expéditeur — les autres n'ont même pas à être interrogés, et le champ
   * n'apparaîtra pas dans leur charge. Le filtrage est ici, pas côté client.
   */
  const mesAppareils = [
    ...new Set(
      page
        .filter((m) => m.senderId === userId && m.appareilId != null)
        .map((m) => m.appareilId as number),
    ),
  ];
  const pseudoParAppareil = new Map<number, string>();
  if (mesAppareils.length > 0) {
    const lignes = await prisma.appareil.findMany({
      // alanyaId en plus de l'id : la ceinture et les bretelles, au cas où un
      // message porterait l'appareil d'un autre compte.
      where: { appareilId: { in: mesAppareils }, alanyaId: userId },
      select: { appareilId: true, agent: true },
    });
    for (const l of lignes) {
      if (l.agent) pseudoParAppareil.set(l.appareilId, l.agent);
    }
  }

  // --- Snapshots des messages cités (replyTo) ---
  // On récupère en une seule requête tous les messages référencés par replyToId,
  // pour pouvoir afficher l'aperçu côté UI même si le message original n'est pas
  // chargé en mémoire locale.
  const replyIds = [...new Set(
    page.map((m) => m.replyToId).filter(Boolean) as string[],
  )];
  const replyTargets = replyIds.length > 0
    ? await prisma.message.findMany({
        where: { id: { in: replyIds } },
        select: { id: true, senderId: true, content: true, type: true, deletedAt: true },
      })
    : [];
  const replyMap = new Map(replyTargets.map((t) => [t.id, t]));

  return ok({
    messages: page.map((m) => {
      let replyTo = null;
      if (m.replyToId && replyMap.has(m.replyToId)) {
        const t = replyMap.get(m.replyToId)!;
        replyTo = {
          id: m.replyToId,
          senderId: t.senderId,
          type: t.type,
          content: t.deletedAt ? null : t.content,
          isDeleted: t.deletedAt !== null,
        };
      }
      return {
        id: m.id,
        convId: m.convId,
        senderId: m.senderId,
        content: m.content,
        type: m.type,
        status: m.status,
        replyToId: m.replyToId,
        replyTo,
        deletedAt: m.deletedAt,
        editedAt: m.editedAt,
        expiresAt: m.expiresAt,
        starred: m.stars.length > 0,
        reactions: m.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })),
        mentions: m.mentions.map((x) => ({ userId: x.userId, libelle: x.libelle })),
        media: m.media.map((f) => ({
          id: f.id,
          url: `/api/media/${f.id}`,
          filename: f.filename,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          durationMs: f.durationMs,
        })),
        createdAt: m.createdAt,
        // Absent — et non pas vide — quand le lecteur n'a pas à le voir.
        // Le pseudo ET l'appareil qui a envoyé, dans la même charge restreinte
        // au compte. L'appareil sert au client à se reconnaître : un poste
        // n'affiche pas son propre nom au-dessus de ses propres messages.
        ...(m.senderId === userId && m.appareilId != null && pseudoParAppareil.has(m.appareilId)
          ? { nomAgent: pseudoParAppareil.get(m.appareilId), appareilId: m.appareilId }
          : {}),
      };
    }),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
    disappearingSeconds: convCfg?.disappearingSeconds ?? 0,
  });
});

// POST /api/conversations/:id/messages — envoie un message dans la conversation.
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  const body = sendMessageSchema.parse(await req.json());

  /*
   * La séquence d'envoi vit dans `creerMessage` — contrôle de blocage, messages
   * éphémères, liaison des médias, `lastMessage`, compteurs de non-lus.
   *
   * Elle en a été EXTRAITE plutôt que recopiée : l'API v1 avait sa propre
   * version, qui avait perdu quatre de ces cinq éléments en chemin. Voir
   * `src/modules/messaging/envoi.ts`.
   *
   * ⚠️ Sur le blocage, on répond 403 et non 200 : c'est le client qui, le
   * connaissant, n'envoie rien. Cette route est le repli utilisé quand le
   * WebSocket n'acquitte pas — c'est-à-dire exactement ce qui se produit entre
   * deux personnes bloquées. Sans ce refus, le repli serait une porte dérobée.
   */
  const envoi = await creerMessage({
    convId,
    expediteurId: userId,
    type: body.type,
    content: body.content,
    mediaId: body.mediaId,
    mediaIds: body.mediaIds,
    replyToId: body.replyToId,
    mentions: body.mentions,
  });

  if (!envoi.ok) {
    if (envoi.motif === "MEDIA_ETRANGER") {
      return fail("Média inconnu ou non possédé", 403, "MEDIA_FORBIDDEN");
    }
    // Seule une charge CONTACT/LOCATION peut arriver ici : le texte ordinaire
    // est coupé silencieusement, jamais refusé.
    if (envoi.motif === "CONTENU_TROP_LONG") {
      return fail("Charge trop longue (500 caractères maximum)", 422, "CONTENT_TOO_LONG");
    }
    return fail("Message non distribuable", 403, "BLOCKED");
  }

  return ok(serialiserMessage(envoi.message), 201);
});
