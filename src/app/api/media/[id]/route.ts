import { type NextRequest, NextResponse } from "next/server";
import { fail, handleError, HttpError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { withAuth, requireUser, UnauthorizedError } from "@/lib/auth-context";
import { verifyAccessToken } from "@/lib/jwt";
import {
  readStored,
  getSignedDownloadUrl,
  deleteStored,
  useCloudStorage,
} from "@/modules/media/storage";

// Récupère l'userId via le Bearer OU via ?token= (utile pour le côté web,
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
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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

    // ?download=1 force le téléchargement (Content-Disposition: attachment),
    // utile même en cross-origin depuis l'app web.
    const forceDownload = req.nextUrl.searchParams.get("download") === "1";
    const safeName = encodeURIComponent(media.filename || `fichier-${media.id}`);

    // ---- Backend cloud (Backblaze B2) : redirection vers une URL présignée.
    // On délègue le transfert du binaire au CDN B2 (économie de bande passante
    // + performances), tout en gardant le contrôle d'accès côté backend : la
    // vérification owner/participant ci-dessus a déjà été faite avant de signer.
    if (useCloudStorage()) {
      const signedUrl = await getSignedDownloadUrl(media.url, {
        responseContentDisposition: forceDownload
          ? `attachment; filename*=UTF-8''${safeName}`
          : undefined,
      }).catch((err) => {
        console.error("[media] Échec signature URL B2 :", err);
        throw new HttpError(502, "Fichier inaccessible sur le stockage", "STORAGE_ERROR");
      });

      if (signedUrl) {
        return NextResponse.redirect(signedUrl, {
          status: 302,
          headers: { "Cache-Control": "private, max-age=86400" },
        });
      }
    }

    // ---- Backend local : on lit le binaire et on le streame.
    try {
      const buffer = await readStored(media.url);
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

// DELETE /api/media/:id — supprime le média (base + binaire stocké).
// Seul le propriétaire peut supprimer son média.
export const DELETE = withAuth(
  async (_req: NextRequest, userId: string, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;

    const media = await prisma.mediaFile.findUnique({ where: { id } });
    if (!media) return fail("Média introuvable", 404, "NOT_FOUND");
    if (media.ownerId !== userId) return fail("Accès refusé", 403, "FORBIDDEN");

    // Supprime d'abord le binaire (local ou B2), puis l'enregistrement en base.
    // deleteStored est best-effort : un objet déjà absent ne fait pas échouer.
    await deleteStored(media.url);
    await prisma.mediaFile.delete({ where: { id } });

    return NextResponse.json({ ok: true }, { status: 200 });
  },
);
