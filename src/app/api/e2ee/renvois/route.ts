import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";

/**
 * RENVOI PAR L'EXPÉDITEUR (piste B, 14/11/2026).
 *
 * 🔴 LE TROU QU'ON BOUCHE. Un message chiffré à deux n'existe que dans les
 * enveloppes faites pour CHAQUE appareil du destinataire. Si aucun ne l'a
 * relevé avant de disparaître (téléphone perdu, réinitialisé, coffre réparé),
 * le nouvel appareil ne peut pas le lire : personne ne l'a chiffré pour lui.
 * L'expéditeur, lui, a gardé le clair (son cache, son archive). Le nouvel
 * appareil DEMANDE ; un appareil de l'expéditeur rechiffre et dépose
 * (`renvois/servir`).
 *
 * ⚠️ LE SERVEUR NE VOIT QUE DES IDENTIFIANTS. Il choisit lui-même les messages
 * éligibles : un appareil ne peut pas réclamer n'importe quel message.
 *
 * Éligible : message d'un fil à deux chiffré dont je suis membre, écrit par
 * l'autre, de moins de 30 jours, ni supprimé ni à vue unique, qui m'avait été
 * chiffré (au moins une enveloppe pour moi) mais qu'AUCUN de mes appareils n'a
 * relevé, et que CET appareil n'a jamais reçu.
 */

/** Combien de messages une demande peut réclamer d'un coup. */
const DEMANDES_MAX = 300;

/** POST — l'appareil [deviceId] demande ce qui lui manque. */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  let corps: { deviceId?: unknown };
  try {
    corps = (await req.json()) ?? {};
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const deviceId = corps.deviceId;
  if (typeof deviceId !== "number" || !Number.isInteger(deviceId)) {
    return fail("« deviceId » est requis", 400, "BAD_BODY");
  }
  const appareil = await prisma.e2eeIdentite.findFirst({
    where: { userId, deviceId },
    select: { id: true },
  });
  if (!appareil) return fail("Appareil inconnu", 404, "NOT_FOUND");

  const manquants = await prisma.$queryRaw<{ id: string; conv: string; exp: string }[]>`
    SELECT m."msgID" AS id, m."conversationID" AS conv, m."senderID" AS exp
    FROM "message" m
    JOIN "conversation" c ON c."conversID" = m."conversationID"
      AND c."e2ee_actif" = TRUE AND c."isGroup" = FALSE
    JOIN "conv_participants" p ON p."conversID" = c."conversID" AND p."alanyaID" = ${userId}::uuid
    WHERE m."senderID" <> ${userId}::uuid
      AND m."deletedAt" IS NULL
      AND m."vue_unique" = FALSE
      AND m."sendAt" > now() - interval '30 days'
      AND EXISTS (
        SELECT 1 FROM "e2ee_enveloppes" e
        WHERE e."message_id" = m."msgID" AND e."destinataire_id" = ${userId}::uuid
      )
      AND NOT EXISTS (
        SELECT 1 FROM "e2ee_enveloppes" e
        WHERE e."message_id" = m."msgID" AND e."destinataire_id" = ${userId}::uuid
          AND (e."remis_le" IS NOT NULL OR e."destinataire_device" = ${deviceId})
      )
    ORDER BY m."sendAt" DESC
    LIMIT ${DEMANDES_MAX}
  `;
  if (manquants.length === 0) return ok({ demandes: 0 });

  const { count } = await prisma.e2eeRenvoi.createMany({
    data: manquants.map((m) => ({
      messageId: m.id,
      convId: m.conv,
      expediteurId: m.exp,
      demandeurId: userId,
      demandeurDevice: deviceId,
    })),
    skipDuplicates: true,
  });

  // Les expéditeurs connectés servent tout de suite ; les autres, à leur
  // prochain lancement (`GET`).
  await previensDesPersonnes({
    personnes: [...new Set(manquants.map((m) => m.exp))],
    type: "e2ee_renvoi",
  });

  return ok({ demandes: count });
});

/** GET — les demandes que MES appareils peuvent servir. */
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const demandes = await prisma.e2eeRenvoi.findMany({
    where: {
      expediteurId: userId,
      serviLe: null,
      creeLe: { gt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
    },
    orderBy: { creeLe: "asc" },
    take: 100,
    select: {
      id: true,
      messageId: true,
      convId: true,
      demandeurId: true,
      demandeurDevice: true,
    },
  });
  return ok({ demandes });
});
