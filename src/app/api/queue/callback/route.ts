import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { centresDeLAgent } from "@/lib/queue-agents";
import { estOccupe, conversationMeta, DELAI_SANS_REPONSE_MS } from "@/lib/calls";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

/**
 * POST /api/queue/callback — un agent rappelle un client SOUS LE NOM DU
 * CENTRE (typiquement un client trouvé abandonné via `/api/queue/history`).
 *
 * Body : { centerAlanyaID, customerId, type? }
 *
 * `initiatorId` de l'appel créé reste le VRAI agent — sécurité, verrous,
 * historique côté agent tous inchangés. `callerMaskId = centerAlanyaID` fait
 * le reste (voir `serialiseAppelPour` et `handleCallRing`) : le client ne
 * verra jamais que le centre.
 *
 * La conversation utilisée est celle du CENTRE avec le client — jamais une
 * conversation avec l'agent, qu'il n'a jamais vu et ne doit pas découvrir.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const body = await req.json();
    const centerAlanyaID = typeof body.centerAlanyaID === "string" ? body.centerAlanyaID : null;
    const customerId = typeof body.customerId === "string" ? body.customerId : null;
    const type = body.type === "VIDEO" ? "VIDEO" : "AUDIO";

    if (!centerAlanyaID || !customerId) {
      return fail("Paramètres `centerAlanyaID` et `customerId` requis", 400, "MISSING_PARAMS");
    }

    const mesCentres = await centresDeLAgent(userId);
    if (!mesCentres.includes(centerAlanyaID)) {
      return fail("Ce centre ne fait pas partie des vôtres", 403, "FORBIDDEN_CENTER");
    }

    const client = await prisma.user.findUnique({ where: { id: customerId } });
    if (!client) return fail("Client introuvable", 404, "NOT_FOUND");

    // Même nettoyage que POST /api/calls : des appels restés en sonnerie après
    // un crash de l'agent ne doivent pas bloquer un rappel légitime.
    const staleThreshold = new Date(Date.now() - DELAI_SANS_REPONSE_MS);
    const staleCalls = await prisma.callParticipant.findMany({
      where: {
        userId,
        leftAt: null,
        call: { status: "RINGING", startedAt: { lt: staleThreshold } },
      },
      select: { callId: true },
    });
    if (staleCalls.length > 0) {
      const ids = staleCalls.map((s) => s.callId);
      await prisma.call.updateMany({ where: { id: { in: ids } }, data: { status: "NO_ANSWER", endedAt: new Date() } });
      await prisma.callParticipant.updateMany({ where: { callId: { in: ids } }, data: { leftAt: new Date() } });
    }

    if (await estOccupe(userId)) {
      return fail("Vous êtes déjà en appel", 409, "BUSY");
    }
    if (await estOccupe(customerId)) {
      return fail("Le client est déjà en appel", 409, "CALLEE_BUSY");
    }

    const conv = await findOrCreateDirectConversation(centerAlanyaID, customerId);

    const call = await prisma.call.create({
      data: {
        initiatorId: userId,
        callerMaskId: centerAlanyaID,
        convId: conv.id,
        type,
        status: "RINGING",
        participants: {
          create: [
            { userId, joinedAt: new Date() },
            { userId: customerId, joinedAt: null },
          ],
        },
      },
      include: { callerMask: true },
    });

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
        callees: [
          {
            userId: customerId,
            pseudo: nomAffichage(client),
            publicNumber: client.publicNumber,
            avatarUrl: avatarPublicUrl(client.avatarUrl ?? null),
          },
        ],
        // Nom du CENTRE, pas de l'agent — c'est ce que l'écran d'appel de
        // l'agent doit afficher : « Appel en cours au nom de … ».
        callerName: call.callerMask ? nomAffichage(call.callerMask) : null,
      },
      201,
    );
  } catch (e: any) {
    return fail(`Erreur lors du rappel: ${e?.message ?? e}`, 500);
  }
});
