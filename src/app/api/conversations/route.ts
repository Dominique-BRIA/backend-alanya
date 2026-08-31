import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createConversationSchema } from "@/lib/validation";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { serialiseAppelPour } from "@/lib/calls";
import { nomAffichage } from "@/lib/display-name.mjs";
// Le libellé d'une ligne d'un message — la règle est décidée là, pour les trois
// clients qui lisent `conversation.lastMessage` tel quel.
import { apercuMessage } from "@/lib/message-payload.mjs";
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
        include: { callerMask: true, participants: { include: { user: true } } },
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
   * Un verrou ne se perime plus : il survit a la deconnexion et n'est retire
   * que par son detenteur. Il n'y a donc plus rien a ecarter a la lecture.
   */
  const verrous = await prisma.conversationLock.findMany({
    where: { userId },
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
    /*
     * ⚠️ LA CONVERSATION AVEC SOI-MÊME N'A PAS D'« AUTRE ».
     *
     * `others` y est vide, et le repli tombait alors sur « Inconnu » — le nom le
     * plus trompeur possible pour ses propres notes. Elle se reconnaît sans
     * ambiguïté à sa forme : non-groupe et un seul participant, forme qu'aucune
     * conversation de production n'avait avant celle-ci (vérifié).
     *
     * Le drapeau `isSelf` part avec la charge plutôt que d'être redéduit par
     * chaque client : les trois auraient sinon à connaître la règle, et le
     * mobile affiche déjà « Inconnu » pour toute conversation dont il ne trouve
     * pas le correspondant.
     */
    const isSelf = !conv.isGroup && conv.participants.length === 1;
    const title = conv.isGroup
      ? conv.name
      : isSelf
        ? "Moi"
        : (others[0] ? nomAffichage(others[0].user) : null) ?? "Inconnu";

    // F11 : dernier message — utilise le champ dénormalisé OU le fallback
    const fallbackLast = conv.messages[0];
    /*
     * 🔴 LE REPLI PASSE PAR `apercuMessage`, ET C'EST CE QUI RÉPARE L'EXISTANT.
     *
     * Le défaut signalé le 18/08/2026 — « j'envoie une photo, la liste affiche
     * l'état du dernier appel » — vient d'ici : pour un média SANS LÉGENDE,
     * `conv.lastMessage` valait NULL (le libellé n'était calculé que pour
     * CONTACT et LOCATION) et `fallbackLast.content` était vide lui aussi. La
     * route rendait donc `lastMessage: null`, et le client bascule alors sur
     * l'aperçu du dernier APPEL, sans condition.
     *
     * Corriger seulement l'écriture aurait laissé les conversations DÉJÀ dans
     * cet état — 6 sur 94 en production — cassées jusqu'au message suivant.
     * Calculer le libellé ici aussi les répare toutes, sans migration de
     * données ni écriture : c'est une lecture, elle vaut pour l'historique.
     */
    const lastContent =
      conv.lastMessage ??
      (fallbackLast
        ? apercuMessage(fallbackLast.type, fallbackLast.content)
        : null);
    const lastType = conv.lastMessageType != null
        ? _typeToString(conv.lastMessageType)
        : (fallbackLast?.type ?? null);
    const lastSenderId = conv.lastMessageSenderID ?? fallbackLast?.senderId ?? null;
    const lastCreatedAt = conv.lastMessageAt ?? fallbackLast?.createdAt ?? null;

    return {
      id: conv.id,
      isGroup: conv.isGroup,
      /// Mes notes personnelles. Envoyé explicitement : un client qui l'ignore
      /// affiche « Moi » comme titre et se comporte normalement — dégradé,
      /// jamais cassé.
      isSelf,
      title,
      /*
       * 🐛 « MOI » N'AVAIT PAS DE PHOTO (signalé le 19/08/2026).
       *
       * L'avatar se lisait chez `others[0]`, qui n'existe justement pas pour la
       * conversation avec soi-même : la liste affichait donc l'initiale de
       * « Moi » sur fond de couleur, alors que l'appareil connaît parfaitement
       * mon visage. Dans mes notes, l'autre bout, c'est moi — c'est donc ma
       * photo qu'il faut rendre, et `conv.participants[0]` EST moi puisque je
       * suis le seul participant.
       *
       * Corrigé ICI et non dans les clients : les trois lisent la même charge,
       * et le web aurait sinon gardé le défaut.
       */
      avatarUrl: avatarPublicUrl(
        conv.isGroup
          ? conv.avatarUrl
          : isSelf
            ? conv.participants[0]?.user.avatarUrl ?? null
            : others[0]?.user.avatarUrl ?? null,
      ),
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
          // Le rôle est posé à la création — le créateur naît ADMIN — mais il
          // n'était pas renvoyé. Faute de le connaître, le client le devinait à
          // la position dans la liste : chacun désignait donc un administrateur
          // différent, et aucun n'était le créateur. Une seule colonne, lue par
          // tout le monde, et les membres d'un groupe voient enfin les mêmes.
          role: pp.role,
          /*
           * JUSQU'OÙ CE MEMBRE A LU. Ajout FACULTATIF : les clients qui ne le
           * connaissent pas l'ignorent, et aucun champ existant ne bouge.
           *
           * Sans lui, un client qui vient d'ouvrir un groupe ne peut pas dire
           * combien de personnes ont lu un message : il n'apprend les lectures
           * que par les trames `read` reçues PENDANT qu'il regarde, et tout ce
           * qui a été lu avant son arrivée lui reste invisible. Le compteur
           * repartirait de zéro à chaque rechargement.
           *
           * `null` = ce membre n'a jamais ouvert la conversation. C'est une
           * information, pas une absence de donnée : il n'a rien lu.
           *
           * Aucune migration — la colonne existe et sert déjà au compteur de
           * non-lus et à l'écran « infos du message ».
           */
          lastReadAt: pp.lastReadAt ?? null,
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
      /*
       * Notifications coupées pour MOI dans cette conversation.
       *
       * Ajout FACULTATIF : les clients qui l'ignorent ne changent pas de
       * comportement. À côté de `unread` parce que c'est la même nature —
       * l'état du LECTEUR sur cette conversation, et non celui de la
       * conversation elle-même.
       */
      sourdine: p.sourdine === 1,
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

    /*
     * 🔴 L'INTERDICTION DE SE PARLER À SOI-MÊME EST LEVÉE (18/08/2026).
     *
     * Elle renvoyait `400 SELF`, et c'était le bon réflexe tant que le cas
     * n'était pas modélisé : `findOrCreateDirectConversation(moi, moi)` aurait
     * rendu la conversation d'un tiers, puis violé l'unicité en créant deux
     * participants identiques. Le garde protégeait donc d'un vrai dégât.
     *
     * Ce que le user demande — le « Moi » de WhatsApp, pour se garder des notes
     * — est désormais une forme à part entière : une conversation non-groupe à
     * UN participant, traitée par `findOrCreateSelfConversation`. Le garde n'a
     * plus lieu d'être, et son maintien empêcherait la fonctionnalité.
     */
    const conv = await findOrCreateDirectConversation(userId, target.id);
    return ok({ id: conv.id, isGroup: false, isSelf: target.id === userId }, 201);
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
