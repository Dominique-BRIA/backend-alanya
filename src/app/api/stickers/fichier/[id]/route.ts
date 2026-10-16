import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { fail } from "@/lib/http";
import { readStored } from "@/modules/media/storage";

/**
 * GET /api/stickers/fichier/:id — l'image d'un sticker, SANS JETON : un
 * sticker est un contenu public, et l'appareil doit pouvoir le mettre en cache.
 *
 * Un fichier retiré par la modération répond 410 ; le cache est court (1 jour)
 * pour qu'un retrait finisse par atteindre les appareils.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const brut = (await ctx.params).id;
  if (!/^\d{1,18}$/.test(brut)) return fail("Introuvable", 404, "NOT_FOUND");
  const a = await prisma.stickerAsset.findUnique({ where: { id: BigInt(brut) } });
  if (!a) return fail("Introuvable", 404, "NOT_FOUND");
  if (a.statut !== 0) return fail("Sticker retiré", 410, "STICKER_REMOVED");
  const octets = await readStored(a.url, a.espace);
  return new Response(new Uint8Array(octets), {
    headers: { "Content-Type": a.mime, "Cache-Control": "public, max-age=86400" },
  });
}
