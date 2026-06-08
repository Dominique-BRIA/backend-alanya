import { type NextRequest } from "next/server";
import { fail, handleError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { requireUser, UnauthorizedError } from "@/lib/auth-context";
import { verifyAccessToken } from "@/lib/jwt";
import { readStored } from "@/modules/media/storage";

// Récupère l'userId via le Bearer OU via ?token= (utile pour <img> côté web,
// qui ne peut pas envoyer d'en-tête Authorization).
function resolveUserId(req: NextRequest): string {
  try {
    return requireUser(req).sub;
  } catch {
    const token = req.nextUrl.searchParams.get("token");
    if (token) {
      const payload = verifyAccessToken(token);
      if (payload.scope === "access") return payload.sub;
    }
    throw new UnauthorizedError("Token manquant ou invalide");
  }
}

// GET /api/media/:id — sert le binaire à un utilisateur autorisé.
// Autorisé si : propriétaire du média, ou participant d'une conversation où il est attaché.
export async function GET(req: NextRequest, ctx: { params: Promise<Record<string, string>> }) {
  try {
    const userId = resolveUserId(req);
    const { id } = await ctx.params;

    const media = await prisma.mediaFile.findUnique({
      where: { id },
      include: { message: { include: { conv: { include: { participants: true } } } } },
    });
    if (!media) return fail("Média introuvable", 404, "NOT_FOUND");

    const isOwner = media.ownerId === userId;
    const isParticipant =
      media.message?.conv.participants.some((p) => p.userId === userId) ?? false;
    if (!isOwner && !isParticipant) return fail("Accès refusé", 403, "FORBIDDEN");

    try {
      const buffer = await readStored(media.url);
      // ?download=1 force le téléchargement (Content-Disposition: attachment),
      // utile même en cross-origin depuis l'app web.
      const forceDownload = req.nextUrl.searchParams.get("download") === "1";
      const safeName = encodeURIComponent(media.filename || `fichier-${media.id}`);
      const headers: Record<string, string> = {
        "Content-Type": media.mimeType,
        "Content-Length": String(media.sizeBytes),
        "Cache-Control": "private, max-age=86400",
        "Content-Disposition": `${forceDownload ? "attachment" : "inline"}; filename*=UTF-8''${safeName}`,
      };
      return new Response(new Uint8Array(buffer), { status: 200, headers });
    } catch {
      return fail("Fichier manquant sur le serveur", 410, "GONE");
    }
  } catch (err) {
    if (err instanceof UnauthorizedError) return fail(err.message, 401, "UNAUTHORIZED");
    return handleError(err);
  }
}
