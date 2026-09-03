import { type NextRequest, NextResponse } from "next/server";
import { fail, handleError, HttpError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { withAuth, requireUser, UnauthorizedError } from "@/lib/auth-context";
import { formesStockeesPour } from "@/lib/avatar";
import { verifyAccessToken } from "@/lib/jwt";
import {
  readStored,
  getSignedDownloadUrl,
  deleteStored,
  useCloudStorage,
} from "@/modules/media/storage";
import { peutVoirStatutsDe } from "@/lib/statut-visibilite";


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

/**
 * Le média illustre-t-il un STATUT que ce demandeur a le droit de voir ?
 *
 * 🔴 SANS CE CONTRÔLE, LA PHOTO ET LA VIDÉO D'UN STATUT SONT INVISIBLES POUR
 * TOUT LE MONDE SAUF LEUR AUTEUR. Un média de statut n'est attaché à aucun
 * message : `isParticipant` est donc toujours faux, et le seul à passer était
 * le propriétaire. Le fil listait bien les statuts des contacts, mais chaque
 * binaire repartait en 403 — un statut média ne s'ouvrait jamais.
 *
 * La règle d'accès est EXACTEMENT celle du fil (`GET /api/statuses`) : on voit
 * les statuts non expirés des personnes qu'on a dans ses contacts. Les deux
 * doivent rester accordées, sinon une vignette s'affiche dans la liste sans
 * que son contenu s'ouvre.
 */
async function peutVoirStatutDuMedia(userId: string, mediaId: string): Promise<boolean> {
  // `mediaUrl` est écrit par POST /api/statuses sous cette forme exacte, et
  // par lui seul.
  const statut = await prisma.status.findFirst({
    where: { mediaUrl: `/api/media/${mediaId}`, expiresAt: { gt: new Date() } },
    select: { userId: true },
  });
  if (!statut) return false;

  // 🔴 LA MÊME RÈGLE QUE LE FIL, ET LE MÊME CODE. C'est la seule garantie que
  // les deux ne divergent pas : une vignette listée dont le binaire repart en
  // 403 est exactement ce qui est arrivé le 02/09.
  return peutVoirStatutsDe(userId, statut.userId);
}

// GET /api/media/:id — sert le binaire à un utilisateur autorisé.
// Autorisé si : propriétaire du média, participant d'une conversation où il est
// attaché, avatar d'un profil, ou média d'un statut visible par le demandeur.
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

    // Un média est aussi accessible s'il est utilisé comme avatar d'un profil.
    const isAvatar = !isOwner && !isParticipant
      ? Boolean(
          await prisma.user.findFirst({
            where: { avatarUrl: { in: formesStockeesPour(id) } },
            select: { id: true },
          }),
        )
      : false;

    const isStatus = !isOwner && !isParticipant && !isAvatar
      ? await peutVoirStatutDuMedia(userId, id)
      : false;

    if (!isOwner && !isParticipant && !isAvatar && !isStatus) {
      return fail("Accès refusé", 403, "FORBIDDEN");
    }

    // Si l'URL du média est une URL HTTP/HTTPS externe (ex: hébergée sur un serveur distant ou transmise via l'API)
    if (/^https?:\/\//i.test(media.url)) {
      return NextResponse.redirect(media.url, {
        status: 302,
        headers: { "Cache-Control": "public, max-age=86400" },
      });
    }

    const forceDownload = req.nextUrl.searchParams.get("download") === "1";
    const safeName = encodeURIComponent(media.filename || `fichier-${media.id}`);

    // ---- Backend cloud (Backblaze B2) : redirection vers une URL présignée.
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
export const DELETE = withAuth(async (_req, userId, ctx) => {
  const { id } = await ctx.params;

  const media = await prisma.mediaFile.findUnique({ where: { id } });
  if (!media) return fail("Média introuvable", 404, "NOT_FOUND");
  if (media.ownerId !== userId) return fail("Accès refusé", 403, "FORBIDDEN");

  await deleteStored(media.url);
  await prisma.mediaFile.delete({ where: { id } });

  return NextResponse.json({ ok: true }, { status: 200 });
});
