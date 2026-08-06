import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createConversationSchema } from "@/lib/validation";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { serialiseAppelPour } from "@/lib/calls";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

// Convertit le type entier (BD) en string (API)
function _typeToString(t: number | null): string {
  switch (t) {
    case 0: return "TEXT";
    case 1: return "IMAGE";
    case 2: return "FILE";
    case 3: return "AUDIO";
    case 4: return "VIDEO";
    default: return "TEXT";
  }
}

// GET /api/conversations — liste les conversations de l'utilisateur.
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const showArchived = req.nextUrl.searchParams.get("archived") === "true";

  const parts = await prisma.participant.findMany({
    where: {
      userId,
      ...(showArchived ? {} : { isArchived: 0 }),
    },
    include: {
      conv: {
        include: {
          participants: { include: { user: true } },
          // Fallback : charge le dernier message si lastMessage est NULL
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
  });

  // Dernier appel de chaque conversation, en UNE requête.
  //
  // Le client chargeait jusqu'ici les 50 derniers appels par un second appel
  // HTTP, puis reconstruisait lui-même la table « conversation → dernier
  // appel ». Deux défauts : une requête de plus à chaque ouverture, et une
  // fenêtre de 50 appels — au-delà, les conversations les moins actives
  // perdaient leur aperçu d'appel sans que rien ne le signale.
  //
  // `distinct` sur convId APRÈS un tri décroissant : PostgreSQL ne garde que la
  // première ligne de chaque groupe, donc l'appel le plus récent.
  const convIds = parts.map((p) => p.conv.id);
  const derniersAppels = convIds.length
    ? await prisma.call.findMany({
        where: { convId: { in: convIds } },
        orderBy: { startedAt: "desc" },
        distinct: ["convId"],
        include: { participants: { include: { user: true } } },
      })
    : [];
  const appelParConv = new Map(derniersAppels.map((c) => [c.convId as string, c]));

  /// Date de la dernière ACTIVITÉ d'une conversation, appels compris.
  ///
  /// Le tri ne regardait que le dernier message : passer un appel ne faisait pas
  /// remonter la conversation, alors qu'un appel est une activité au même titre
  /// qu'un message. C'est le comportement de WhatsApp, et c'est aussi ce que la
  /// liste affiche déjà — l'aperçu montre l'appel quand il est plus récent, mais
  /// la conversation restait en bas.
  const dateActivite = (p: (typeof parts)[number]) => {
    const message =
      p.conv.lastMessageAt ?? p.conv.messages[0]?.createdAt ?? p.conv.createdAt;
    const appel = appelParConv.get(p.conv.id)?.startedAt;
    return appel && appel > message ? appel : message;
  };

  // Trie : épinglés d'abord, puis par date de dernière activité.
  parts.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return b.isPinned - a.isPinned;
    return dateActivite(b).getTime() - dateActivite(a).getTime();
  });

  /**
   * Verrous poses par les appareils de ce compte, en une seule requete.
   *
   * Les perimes sont ecartes a la lecture : le nettoyage periodique du serveur
   * temps reel peut avoir jusqu'a 30 s de retard, et une conversation ne doit
   * pas paraitre reservee alors qu'elle ne l'est plus.
   */
  const verrous = await prisma.conversationLock.findMany({
    where: { userId, expiresAt: { gt: new Date() } },
    select: { convId: true, appareilId: true, detenteur: true, expiresAt: true },
  });
  const verrousParConv = new Map(
    verrous.map((v) => [
      v.convId,
      { appareilId: v.appareilId, detenteur: v.detenteur, expiresAt: v.expiresAt },
    ]),
  );

  const conversations = parts.map((p) => {
    const conv = p.conv;
    const others = conv.participants.filter((pp) => pp.userId !== userId);
    const title = conv.isGroup
      ? conv.name
      : (others[0] ? nomAffichage(others[0].user) : null) ?? "Inconnu";

    // F11 : dernier message — utilise le champ dénormalisé OU le fallback
    const fallbackLast = conv.messages[0];
    const lastContent = conv.lastMessage ?? fallbackLast?.content ?? null;
    const lastType = conv.lastMessageType != null
        ? _typeToString(conv.lastMessageType)
        : (fallbackLast?.type ?? null);
    const lastSenderId = conv.lastMessageSenderID ?? fallbackLast?.senderId ?? null;
    const lastCreatedAt = conv.lastMessageAt ?? fallbackLast?.createdAt ?? null;

    return {
      id: conv.id,
      isGroup: conv.isGroup,
      title,
      avatarUrl: avatarPublicUrl(conv.isGroup ? conv.avatarUrl : others[0]?.user.avatarUrl ?? null),
      members: conv.participants.map((pp) => {
        // Confidentialité : masque la présence d'un pair qui a choisi « personne ».
        const hidePresence =
          pp.userId !== userId && pp.user.lastSeenVisibility === 0;
        return {
          id: pp.userId,
          pseudo: nomAffichage(pp.user),
          publicNumber: pp.user.publicNumber,
          isOnline: hidePresence ? 0 : pp.user.isOnline,
          lastSeen: hidePresence ? null : (pp.user.lastSeen ?? null),
        };
      }),
      lastMessage: lastContent != null
          ? {
              id: fallbackLast?.id ?? "",
              content: lastContent,
              type: lastType ?? "TEXT",
              senderId: lastSenderId ?? "",
              createdAt: lastCreatedAt ?? conv.createdAt,
            }
          : null,
      // Dernier appel, déjà formulé pour CE destinataire — même règle que dans
      // `call_ended` : sortant pour l'un, entrant pour l'autre.
      lastCall: (() => {
        const appel = appelParConv.get(conv.id);
        if (!appel) return null;
        return serialiseAppelPour(
          appel,
          { isGroup: conv.isGroup, name: conv.name },
          userId,
        );
      })(),
      unread: p.unreadCount,
      isPinned: p.isPinned === 1,
      isArchived: p.isArchived === 1,
      // Verrou pose par un appareil de CE compte, s'il en existe un et qu'il
      // n'est pas perime. Il ne gouverne que l'ecriture : la conversation reste
      // lisible, et les messages continuent d'arriver.
      lock: verrousParConv.get(conv.id) ?? null,
      // Même définition que celle qui a servi au tri : sinon la liste serait
      // ordonnée sur une date et en afficherait une autre.
      updatedAt: dateActivite(p),
    };
  });

  return ok({ conversations });
});

// POST /api/conversations — crée (ou récupère) une conversation.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = createConversationSchema.parse(await req.json());

  if (body.publicNumber) {
    const target = await prisma.user.findUnique({ where: { publicNumber: body.publicNumber } });
    if (!target) return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
    if (target.id === userId) return fail("Conversation avec soi-même impossible", 400, "SELF");

    const conv = await findOrCreateDirectConversation(userId, target.id);
    return ok({ id: conv.id, isGroup: false }, 201);
  }

  const members = await prisma.user.findMany({
    where: { publicNumber: { in: body.memberNumbers! } },
    select: { id: true },
  });
  const memberIds = new Set(members.map((m) => m.id));
  memberIds.add(userId);

  const conv = await prisma.conversation.create({
    data: {
      isGroup: true,
      name: body.name!,
      participants: {
        create: Array.from(memberIds).map((id) => ({
          userId: id,
          role: id === userId ? "ADMIN" : "MEMBER",
        })),
      },
    },
  });
  return ok({ id: conv.id, isGroup: true }, 201);
});
