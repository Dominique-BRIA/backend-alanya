import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createCallSchema } from "@/lib/validation";
import { assertParticipant } from "@/modules/messaging/access";
import {
  conversationMeta,
  libelleAppel,
  estOccupe,
  DELAI_SANS_REPONSE_MS,
} from "@/lib/calls";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

// GET /api/calls — historique des appels de l'utilisateur (50 derniers).
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const parts = await prisma.callParticipant.findMany({
    where: { userId },
    orderBy: { call: { startedAt: "desc" } },
    take: 50,
    include: {
      call: {
        include: {
          initiator: true,
          participants: { include: { user: true } },
        },
      },
    },
  });

  const convIds = [...new Set(parts.map((p) => p.call.convId).filter(Boolean))] as string[];
  const convs = await prisma.conversation.findMany({
    where: { id: { in: convIds } },
    select: { id: true, isGroup: true, name: true },
  });
  const convMap = new Map(convs.map((c) => [c.id, c]));

  const calls = parts.map((p) => {
    const c = p.call;
    const others = c.participants.filter((pp) => pp.userId !== userId);
    const conv = c.convId ? convMap.get(c.convId) : null;
    const isGroup = conv?.isGroup ?? false;
    const peer = others[0]?.user;
    const peerName = isGroup
      ? (conv?.name ?? "Groupe")
      : (peer ? nomAffichage(peer) : null) ?? "Inconnu";
    // `isOutgoing` est DÉRIVÉ de l'initiateur réel, il n'est pas stocké : c'est
    // ce qui garantit que la bulle sort du bon côté chez chacun. Le même appel
    // est sortant pour l'un et entrant pour l'autre — un booléen en base ne
    // pourrait pas dire les deux.
    const isOutgoing = c.initiatorId === userId;
    const durationSec =
      c.answeredAt && c.endedAt
        ? Math.round((c.endedAt.getTime() - c.answeredAt.getTime()) / 1000)
        : null;
    return {
      id: c.id,
      convId: c.convId,
      type: c.type,
      status: c.status,
      isOutgoing,
      callerId: c.initiatorId,
      isGroup,
      peerName,
      peerNumber: isGroup ? null : (peer?.publicNumber ?? null),
      peerAvatarUrl: isGroup ? null : (peer?.avatarUrl ?? null),
      participantCount: c.participants.length,
      startedAt: c.startedAt,
      answeredAt: c.answeredAt,
      endedAt: c.endedAt,
      durationSec,
      // Libellé déjà formulé pour CE destinataire. Le client affiche, il ne
      // déduit plus rien du statut brut ni de la durée.
      ...libelleAppel(c.status, isOutgoing, durationSec),
    };
  });

  // Déduplique (un appel = une entrée par participant).
  const seen = new Set<string>();
  const unique = calls.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  return ok({ calls: unique });
});

// POST /api/calls — démarre un appel (statut RINGING) dans une conversation.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const { convId, type } = createCallSchema.parse(await req.json());
  await assertParticipant(convId, userId);

  // AUTO-CLEANUP des appels restés bloqués en sonnerie après un crash de l'app.
  //
  // Deux corrections par rapport à la version précédente :
  //  - le seuil passe de 2 min à 90 s, la valeur du minuteur Telecom côté
  //    Android. Quand les deux divergent, l'appel disparaît de l'écran du
  //    téléphone avant que le serveur ne le clôture ;
  //  - le statut devient NO_ANSWER et non ENDED. Un ENDED sans durée forçait le
  //    client à deviner « personne n'a décroché » à partir de `durationSec == 0`,
  //    ce qui est précisément le bricolage qu'on retire.
  const staleThreshold = new Date(Date.now() - DELAI_SANS_REPONSE_MS);
  const staleCalls = await prisma.callParticipant.findMany({
    where: {
      userId,
      leftAt: null,
      call: {
        status: "RINGING",
        startedAt: { lt: staleThreshold },
      },
    },
    select: { callId: true },
  });
  if (staleCalls.length > 0) {
    await prisma.call.updateMany({
      where: { id: { in: staleCalls.map((s) => s.callId) } },
      data: { status: "NO_ANSWER", endedAt: new Date() },
    });
    await prisma.callParticipant.updateMany({
      where: { callId: { in: staleCalls.map((s) => s.callId) } },
      data: { leftAt: new Date() },
    });
  }

  if (await estOccupe(userId)) {
    return fail("Vous êtes déjà en appel", 409, "BUSY");
  }

  const convParts = await prisma.participant.findMany({
    where: { convId },
    select: { userId: true },
  });
  const memberIds = convParts.map((p) => p.userId);

  // L'APPELÉ est-il déjà en ligne ? Ce contrôle n'existait pas : seul
  // l'appelant était vérifié, si bien qu'un second appelant pouvait faire
  // sonner quelqu'un déjà en communication.
  //
  // Uniquement en direct : dans un groupe, qu'un membre soit occupé ne doit pas
  // empêcher l'appel pour tous les autres.
  const autresMembres = memberIds.filter((id) => id !== userId);
  if (autresMembres.length === 1) {
    const calleeId = autresMembres[0];
    if (await estOccupe(calleeId)) {
      // L'appel est tracé plutôt que simplement refusé : sans cette ligne,
      // l'appelant ne verrait aucune trace de sa tentative dans l'historique.
      // Les deux participants sont marqués `leftAt` : l'appel est clos d'emblée
      // et ne peut pas bloquer un appel suivant.
      const now = new Date();
      await prisma.call.create({
        data: {
          initiatorId: userId,
          convId,
          type,
          status: "BUSY",
          endedAt: now,
          participants: {
            create: memberIds.map((id) => ({ userId: id, leftAt: now })),
          },
        },
      });
      return fail("Le correspondant est déjà en appel", 409, "CALLEE_BUSY");
    }
  }

  const call = await prisma.call.create({
    data: {
      initiatorId: userId,
      convId,
      type,
      status: "RINGING",
      participants: {
        create: memberIds.map((id) => ({
          userId: id,
          joinedAt: id === userId ? new Date() : null,
        })),
      },
    },
    include: {
      initiator: true,
      participants: { include: { user: true } },
    },
  });

  const callees = call.participants
    .filter((p) => p.userId !== userId)
    .map((p) => ({
      userId: p.userId,
      pseudo: nomAffichage(p.user),
      publicNumber: p.user.publicNumber,
      avatarUrl: avatarPublicUrl(p.user.avatarUrl ?? null),
    }));

  const meta = await conversationMeta(call.convId);

  return ok(
    {
      id: call.id,
      convId: call.convId,
      type: call.type,
      status: call.status,
      isGroup: meta.isGroup,
      groupName: meta.groupName,
      memberCount: meta.memberCount,
      callees,
      callerName: nomAffichage(call.initiator),
    },
    201,
  );
});
