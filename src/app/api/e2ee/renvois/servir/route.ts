import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";

/**
 * POST — un appareil de l'EXPÉDITEUR sert une demande de renvoi (piste B,
 * 14/11/2026) : il dépose l'enveloppe rechiffrée pour l'appareil demandeur.
 *
 * Corps : { id, deviceId, type, corps }.
 *
 * ⚠️ UNE DEMANDE NE SE SERT QU'UNE FOIS : deux appareils de l'expéditeur
 * peuvent la voir en même temps. Le premier qui la marque gagne ; l'autre
 * reçoit `deja: true` et ne dépose rien.
 *
 * ⚠️ PAS DE NOTIFICATION : c'est un message ancien. Seule la sonnette temps
 * réel part, pour que l'appareil demandeur relève.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  let r: { id?: unknown; deviceId?: unknown; type?: unknown; corps?: unknown };
  try {
    r = (await req.json()) ?? {};
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  if (typeof r.id !== "string" || r.id === "") return fail("« id » est requis", 400, "BAD_BODY");
  if (typeof r.deviceId !== "number" || !Number.isInteger(r.deviceId)) {
    return fail("« deviceId » est requis", 400, "BAD_BODY");
  }
  if ((r.type !== 1 && r.type !== 3) || typeof r.corps !== "string" || r.corps === "") {
    return fail("Enveloppe mal formée", 400, "BAD_BODY");
  }

  const demande = await prisma.e2eeRenvoi.findUnique({ where: { id: r.id } });
  if (!demande || demande.expediteurId !== userId) {
    return fail("Demande inconnue", 404, "NOT_FOUND");
  }
  // Le message doit toujours être le mien, et vivant.
  const message = await prisma.message.findFirst({
    where: { id: demande.messageId, senderId: userId, deletedAt: null },
    select: { id: true },
  });
  if (!message) return fail("Message inconnu", 404, "NOT_FOUND");

  const { count } = await prisma.e2eeRenvoi.updateMany({
    where: { id: demande.id, serviLe: null },
    data: { serviLe: new Date() },
  });
  if (count === 0) return ok({ deja: true });

  await prisma.e2eeEnveloppe.create({
    data: {
      convId: demande.convId,
      expediteurId: userId,
      expediteurDevice: r.deviceId,
      destinataireId: demande.demandeurId,
      destinataireDevice: demande.demandeurDevice,
      type: r.type,
      corps: r.corps,
      messageId: demande.messageId,
    },
  });

  await previensDesPersonnes({
    personnes: [demande.demandeurId],
    type: "e2ee_arrivee",
    donnees: { convId: demande.convId, messageId: demande.messageId, renvoi: true },
  });

  return ok({ servi: true }, 201);
});
