import { type NextRequest, NextResponse } from "next/server";
import { fail, handleError, HttpError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { peutEntendreAccueil } from "@/lib/repondeur.mjs";
import { withAuth, requireUser, UnauthorizedError } from "@/lib/auth-context";
import { formesStockeesPour } from "@/lib/avatar";
import { verifyAccessToken } from "@/lib/jwt";
import {
  adressePublique,
  readStored,
  getSignedDownloadUrl,
  deleteStored,
  useCloudStorage as stockageNuage,
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
// attaché, avatar d'un profil, média d'un statut visible par le demandeur, ou
// message d'accueil de quelqu'un qu'on vient d'appeler sans réponse.
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

    /*
     * 🐛 LE MESSAGE D'ACCUEIL D'UN RÉPONDEUR N'ENTRAIT DANS AUCUN DES CAS
     * CI-DESSUS, et c'est pourquoi il ne s'est jamais joué pour personne.
     *
     * Il appartient à la personne APPELÉE. L'appelant n'en est pas le
     * propriétaire ; le fichier n'est attaché à aucun message, donc il n'est
     * participant de rien ; ce n'est ni un avatar ni un statut. Cette route lui
     * répondait « Accès refusé », en silence pour une balise `<audio>`.
     *
     * On a cherché du côté de la lecture automatique et des permissions du
     * navigateur. Le son n'arrivait simplement jamais.
     */
    const isAccueil = !isOwner && !isParticipant && !isAvatar && !isStatus
      ? await peutEntendreAccueil(prisma, userId, id)
      : false;

    if (!isOwner && !isParticipant && !isAvatar && !isStatus && !isAccueil) {
      return fail("Accès refusé", 403, "FORBIDDEN");
    }

    /*
     * 🔴 `?flux=1` — « SERS-LE TOI-MÊME, NE ME RENVOIE PAS AILLEURS ».
     *
     * Toutes les voies ci-dessous REDIRIGENT vers Backblaze. Pour une balise
     * `<audio>` ou `<img>`, c'est parfait : le navigateur suit, joue, et le
     * fichier ne traverse jamais ce serveur.
     *
     * Mais un `fetch()` de navigateur qui aboutit sur un AUTRE domaine exige des
     * en-têtes CORS sur le bucket. Sans eux, la requête échoue — et le
     * préchargement de l'accueil, qui est toute la raison d'être du dispositif,
     * tombe en silence. Le dépôt connaît déjà ce mur : `media-preview-cache.ts`
     * a dû se faire un proxy pour la même raison.
     *
     * ⚠️ POUR QUE LE SON NE DÉPENDE PAS D'UNE CASE COCHÉE DANS UNE CONSOLE. Le
     * client réessaie par ici, même origine, aucun CORS en jeu. Régler CORS
     * devient une ÉCONOMIE de bande passante, plus une condition de bon
     * fonctionnement.
     *
     * ⚠️ ET SEULEMENT SOUS UN PLAFOND DE TAILLE. Servir nous-mêmes, c'est payer
     * la bande passante deux fois et charger le fichier en mémoire. Un accueil
     * fait au plus 5 Mo ; au-delà de 8, on redirige quand même — un client qui
     * demanderait à faire transiter des vidéos par le serveur ne doit pas
     * pouvoir l'obtenir juste en ajoutant un paramètre.
     */
    const PLAFOND_FLUX_OCTETS = 8 * 1024 * 1024;
    const parFlux =
      req.nextUrl.searchParams.get("flux") === "1" && media.sizeBytes <= PLAFOND_FLUX_OCTETS;

    // Si l'URL du média est une URL HTTP/HTTPS externe (ex: hébergée sur un serveur distant ou transmise via l'API)
    if (!parFlux && /^https?:\/\//i.test(media.url)) {
      return NextResponse.redirect(media.url, {
        status: 302,
        headers: { "Cache-Control": "public, max-age=86400" },
      });
    }

    /*
     * ⚠️ LE BUCKET OUVERT SE SERT SANS SIGNATURE. Son adresse est fixe, donc
     * mise en cache par le navigateur : un accueil déjà entendu ne se
     * retélécharge pas, et repart à l'instant où la sonnerie s'arrête.
     *
     * On redirige plutôt que de servir nous-mêmes : le fichier ne transite plus
     * par ce serveur du tout.
     */
    const ouverte = parFlux ? null : adressePublique(media.url, media.espace);
    if (ouverte) {
      return NextResponse.redirect(ouverte, {
        status: 302,
        headers: { "Cache-Control": "public, max-age=3600" },
      });
    }

    const forceDownload = req.nextUrl.searchParams.get("download") === "1";
    const safeName = encodeURIComponent(media.filename || `fichier-${media.id}`);

    // ---- Backend cloud (Backblaze B2) : redirection vers une URL présignée.
    if (!parFlux && stockageNuage()) {
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

    // ---- Lecture par ce serveur : disque local, ou repli `?flux=1` du nuage.
    try {
      // ⚠️ AVEC SON ESPACE : un fichier du bucket ouvert n'est pas dans le bucket
      // privé, et le chercher là rendrait « fichier manquant » pour un fichier
      // parfaitement en place.
      const buffer = await readStored(media.url, media.espace);
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

  // ⚠️ AVEC SON ESPACE. Un média public effacé dans le bucket privé ne
  // disparaîtrait de nulle part, et resterait lisible de tout Internet — le
  // pire des deux mondes.
  await deleteStored(media.url, media.espace);
  await prisma.mediaFile.delete({ where: { id } });

  return NextResponse.json({ ok: true }, { status: 200 });
});
