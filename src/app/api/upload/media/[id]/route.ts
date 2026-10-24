import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { fail } from "@/lib/http";
import { readStored } from "@/modules/media/storage";

/**
 * GET /api/upload/media/:id — un média déposé par la console, SANS JETON :
 * c'est un contenu officiel, montré à tous, et l'appareil doit pouvoir le
 * mettre en cache (comme `/api/stickers/fichier/:id`).
 *
 * 🔴 SEULS les fichiers inscrits dans `gestion_media` sont servis : un média
 * d'utilisateur, même désigné par son identifiant, répond 404.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const id = (await ctx.params).id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail("Introuvable", 404, "NOT_FOUND");
  const marque = await prisma.gestionMedia.findUnique({ where: { mediaId: id } });
  if (!marque) return fail("Introuvable", 404, "NOT_FOUND");
  const media = await prisma.mediaFile.findUnique({ where: { id } });
  if (!media) return fail("Introuvable", 404, "NOT_FOUND");
  const octets = await readStored(media.url, media.espace);
  return new Response(new Uint8Array(octets), {
    headers: { "Content-Type": media.mimeType, "Cache-Control": "public, max-age=604800" },
  });
}
