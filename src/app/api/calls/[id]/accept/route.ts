import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { activeCallParticipants, conversationMeta } from "@/lib/calls";
import { marquerRecontacte } from "@/lib/queue";

// POST /api/calls/:id/accept — accepte / rejoint un appel (direct ou groupe).
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const part = await prisma.callParticipant.findUnique({
    where: { callId_userId: { callId: id, userId } },
    include: { call: true },
  });
  if (!part) return fail("Appel introuvable", 404, "NOT_FOUND");
  if (part.call.initiatorId === userId) return fail("L'appelant ne peut pas accepter", 400, "BAD_STATE");
  if (part.joinedAt && !part.leftAt) return fail("Déjà dans l'appel", 409, "ALREADY_JOINED");

  const status = part.call.status;
  // Autorise à rejoindre un appel RINGING ou ONGOING (invitation / transfert en
  // cours d'appel inclus). Le doublon est déjà bloqué par ALREADY_JOINED ci-dessus.
  // NO_ANSWER et BUSY rejoignent la liste : sans eux, un appel expiré par le
  // minuteur des 90 s restait acceptable, et décrocher l'aurait fait repasser
  // en ONGOING alors qu'il était déjà clos.
  if (
    status === "ENDED" ||
    status === "REJECTED" ||
    status === "MISSED" ||
    status === "NO_ANSWER" ||
    status === "BUSY"
  ) {
    return fail("Appel terminé", 409, "BAD_STATE");
  }

  const now = new Date();
  if (status === "RINGING") {
    await prisma.call.update({
      where: { id },
      data: { status: "ONGOING", answeredAt: now },
    });

    /*
     * RAPPEL ABOUTI (15/08/2026) — `callerMaskId` n'est posé que par
     * `POST /api/queue/callback` : sa présence signifie que cet appel est le
     * rappel d'un client abandonné, et on arrive ici parce qu'il A DÉCROCHÉ.
     * Il sort donc de la liste « à rappeler ».
     *
     * Ici et pas à la création de l'appel : un rappel que le client ne prend
     * pas doit rester dans la liste. Et dans le `if (RINGING)` : un
     * participant qui rejoint un appel DÉJÀ en cours (invitation, transfert)
     * n'est pas le décrochage du client rappelé.
     *
     * Volontairement silencieux en cas d'échec — une ligne d'historique de
     * file qui ne bascule pas ne doit pas faire échouer un décrochage.
     */
    if (part.call.callerMaskId) {
      try {
        await marquerRecontacte(part.call.callerMaskId, userId);
      } catch (e) {
        console.error("[accept] marquerRecontacte:", e);
      }
    }
  }
  await prisma.callParticipant.update({
    where: { callId_userId: { callId: id, userId } },
    data: { joinedAt: now, leftAt: null },
  });

  const meta = await conversationMeta(part.call.convId);
  const activeParticipants = await activeCallParticipants(id);

  return ok({
    id,
    status: "ONGOING",
    answeredAt: now,
    isGroup: meta.isGroup,
    groupName: meta.groupName,
    activeParticipants,
  });
});
