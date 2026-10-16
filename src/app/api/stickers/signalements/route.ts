import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { rateLimit } from "@/lib/rate-limit";

const corpsSchema = z.object({
  assetId: z.coerce.number().int().positive(),
  motif: z.enum(["inapproprie", "droits_auteur", "violence", "autre"]),
});

/** POST /api/stickers/signalements — `{ assetId, motif }` : un utilisateur signale une image. */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const quota = await rateLimit(`signalement-sticker:${userId}`, 20, 60 * 60_000);
    if (!quota.allowed) return fail("Trop de signalements, réessayez plus tard", 429, "RATE_LIMITED");
    const c = corpsSchema.parse(await req.json().catch(() => null));
    const a = await prisma.stickerAsset.findUnique({ where: { id: BigInt(c.assetId) }, select: { id: true } });
    if (!a) return fail("Sticker introuvable", 404, "NOT_FOUND");
    const s = await prisma.stickerSignalement.create({ data: { assetId: a.id, auteurId: userId, motif: c.motif } });
    return ok({ id: Number(s.id) }, 201);
  } catch (e) {
    return handleError(e);
  }
});
