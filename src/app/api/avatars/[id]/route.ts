import { type NextRequest, NextResponse } from "next/server";
import { fail, handleError, HttpError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { formesStockeesPour } from "@/lib/avatar";
import { readStored, getSignedDownloadUrl, useCloudStorage } from "@/modules/media/storage";

/**
 * GET /api/avatars/:id — sert une photo de profil, SANS jeton.
 *
 * Décision du 06/08/2026 : les avatars deviennent publics. Ils l'étaient déjà
 * pour tout compte authentifié — le commentaire de `/api/media/[id]` le disait
 * (« par nature publics […] sinon impossible d'afficher l'avatar de tes
 * contacts »). On retire l'authentification, rien d'autre.
 *
 * Ce que « public » signifie ici : accessible à qui détient l'URL. Les
 * identifiants sont des UUID, donc rien ne s'énumère ; il n'existe aucune route
 * qui liste les avatars. C'est le modèle habituel des messageries.
 *
 * ⚠️ POURQUOI UNE ROUTE À PART, et non `/api/media/[id]` ouverte sans jeton :
 * cette route-là sert AUSSI les pièces jointes des conversations. L'ouvrir
 * rendrait publiques les photos et les vocaux échangés en privé. Ici, le
 * contrôle ci-dessous est le seul garde-fou, et il est strict : le média doit
 * être RÉELLEMENT référencé comme avatar par un compte. Sans lui, connaître un
 * identifiant de média suffirait à lire n'importe quel fichier.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;

    // Le contrôle porte sur la forme canonique stockée en base. C'est aussi ce
    // qui garantit qu'un média cesse d'être public dès que le compte change de
    // photo : plus personne ne le référence, la route le refuse.
    //
    // Les photos de GROUPE comptent autant que celles de personnes — elles
    // s'affichent dans la même liste de discussions. Elles vivent dans
    // `conversation.groupPhoto`, pas dans `users`, d'où les deux recherches.
    const formes = formesStockeesPour(id);
    const [estAvatarCompte, estPhotoGroupe] = await Promise.all([
      prisma.user.findFirst({ where: { avatarUrl: { in: formes } }, select: { id: true } }),
      prisma.conversation.findFirst({ where: { avatarUrl: { in: formes } }, select: { id: true } }),
    ]);
    if (!estAvatarCompte && !estPhotoGroupe) {
      return fail("Avatar introuvable", 404, "NOT_FOUND");
    }

    const media = await prisma.mediaFile.findUnique({ where: { id } });
    if (!media) return fail("Avatar introuvable", 404, "NOT_FOUND");

    // Une photo de profil ne change jamais pour un identifiant donné : un
    // nouvel avatar est un nouvel envoi, donc un nouvel identifiant. Le cache
    // peut donc être long et partagé — c'est tout l'intérêt de la rendre
    // publique plutôt que de la transporter en base64 dans chaque réponse.
    const cache = "public, max-age=604800, immutable";

    if (useCloudStorage()) {
      const signedUrl = await getSignedDownloadUrl(media.url).catch((err) => {
        console.error("[avatars] Échec signature URL :", err);
        throw new HttpError(502, "Avatar inaccessible sur le stockage", "STORAGE_ERROR");
      });
      if (signedUrl) {
        return NextResponse.redirect(signedUrl, {
          status: 302,
          headers: { "Cache-Control": cache },
        });
      }
    }

    try {
      const buffer = await readStored(media.url);
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": media.mimeType,
          "Content-Length": String(media.sizeBytes),
          "Cache-Control": cache,
        },
      });
    } catch {
      return fail("Fichier manquant sur le serveur", 410, "GONE");
    }
  } catch (err) {
    return handleError(err);
  }
}
