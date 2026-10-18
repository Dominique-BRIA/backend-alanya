import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { clientIp, rateLimit } from "@/lib/rate-limit";

const consultationSchema = z.object({
  mediaId: z.string().trim().min(1).max(64),
  convId: z.string().trim().max(64).optional(),
  appareil: z.string().trim().max(200).optional(),
});

/**
 * POST /api/documents-sensibles/consultations — la TRACE d'une consultation
 * de document sensible (18/10/2026) : qui, sur quel appareil, quand.
 *
 * Le filigrane est posé par l'application, sur le document déchiffré ; le
 * serveur, qui ne lit pas les fichiers chiffrés de bout en bout, garde ici
 * de quoi remonter une fuite. Ne bloque jamais l'ouverture côté client.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const rl = await rateLimit(`consultation:${userId}`, 60, 60_000);
  if (!rl.allowed) return fail("Trop de consultations", 429, "RATE_LIMITED");
  const parsed = consultationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Données invalides", 422, "VALIDATION");
  const { mediaId, convId, appareil } = parsed.data;
  await prisma.documentConsultation.create({
    data: { userId, mediaId, convId, appareil, ip: clientIp(req).slice(0, 64) },
  });
  return ok({ enregistre: true });
});
