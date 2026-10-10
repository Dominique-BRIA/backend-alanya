import { type NextRequest } from "next/server";
import { fail, handleError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { formesStockeesPour } from "@/lib/avatar";
import { readStored } from "@/modules/media/storage";
import { publierAvatar } from "@/lib/avatar-profil";
import { ESPACE_PROFIL, adresseProfil } from "@/lib/seau-profil.mjs";

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

    /*
     * 🔴 LA PHOTO EST DANS LE SEAU DES PHOTOS DE PROFIL (`alanyaprofile`) :
     * CLOUDFLARE LA SERT, PAS NOUS. Voir `lib/seau-profil.mjs`.
     *
     * ⚠️ CETTE REDIRECTION N'EST PAS CELLE DU 27/09 (lire plus bas). L'adresse
     * cible est FIXE et n'expire jamais : le navigateur peut garder la
     * redirection, puis l'image elle-même un an. Un jour seulement pour la
     * redirection, pour qu'un changement de `R2_PROFIL_URL` se propage vite.
     *
     * Débranché (`STOCKAGE_PROFIL` retiré), `adresseProfil` rend `null` et l'on
     * sert l'original du seau privé, toujours là — comme avant.
     */
    if (media.espace === ESPACE_PROFIL) {
      const adresse = adresseProfil(media.url);
      if (adresse) {
        return new Response(null, {
          status: 302,
          headers: { Location: adresse, "Cache-Control": "public, max-age=86400" },
        });
      }
    }

    /*
     * 🔴 ON SERT LES OCTETS, ON NE REDIRIGE PLUS. C'est une correction.
     *
     * 🐛 LES PHOTOS DE PROFIL ONT CESSÉ DE S'AFFICHER (constaté par le user le
     * 27/09/2026). Cette route redirigeait vers une URL signée valable UNE HEURE
     * en annonçant `max-age=604800, immutable` : le navigateur gardait LA
     * REDIRECTION une semaine, sans droit de revalider, et rejouait une adresse
     * morte au bout d'une heure. Backblaze répondait 403 et l'image disparaissait
     * — sans une ligne dans les journaux, le serveur ayant fait exactement ce
     * qu'on lui demandait.
     *
     * 🔴 ET CORRIGER L'EN-TÊTE N'AURAIT PAS SUFFI. Une URL signée porte une
     * signature DIFFÉRENTE à chaque demande : c'est une adresse neuve chaque
     * fois, donc le navigateur ne peut RIEN mettre en cache. Rediriger, ici,
     * revient à interdire le cache des photos de profil — exactement l'inverse du
     * but.
     *
     * ⚠️ POURQUOI C'EST LE BON ARBITRAGE ICI, ET PAS DANS `/api/media/:id`. Un
     * avatar est une vignette carrée de quelques dizaines de kilo-octets, relue
     * par tous les contacts, à chaque écran. Servie avec sept jours de cache, elle
     * ne traverse ce serveur QU'UNE FOIS PAR SEMAINE ET PAR NAVIGATEUR — moins de
     * trafic au total qu'une redirection rejouée à chaque affichage. Les pièces
     * jointes de conversation, elles, peuvent peser des centaines de mégaoctets et
     * ne s'ouvrent qu'une fois : là, la redirection reste la bonne réponse.
     *
     * ⚠️ `useCloudStorage` N'A PLUS À ÊTRE TESTÉ : `readStored` sait déjà lire le
     * disque ou le bucket. Un aiguillage de moins, c'est un endroit de moins où
     * les deux chemins peuvent diverger imperceptiblement.
     */
    try {
      const buffer = await readStored(media.url, media.espace);
      /*
       * Pas encore dans le seau des photos de profil : on la sert, et on l'y
       * copie au passage — l'affichage suivant passera par Cloudflare. En
       * arrière-plan : ce contact n'attend pas la copie.
       */
      if (media.espace === null) {
        void publierAvatar(media, buffer).catch((e) =>
          console.error("[photos de profil] copie impossible :", e),
        );
      }
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": media.mimeType,
          "Content-Length": String(media.sizeBytes),
          "Cache-Control": cache,
        },
      });
    } catch (err) {
      /*
       * ⚠️ ON LE DIT DANS LES JOURNAUX AVANT DE RÉPONDRE 410. « Fichier manquant »
       * est vrai quand le binaire a disparu, et TROMPEUR quand c'est le bucket qui
       * est injoignable ou la clé refusée — deux pannes qui appellent des gestes
       * opposés. Sans cette trace, on part chercher un fichier perdu qui est à sa
       * place. C'est exactement le silence qui a coûté une demi-journée sur la
       * disparition des photos de profil.
       */
      console.error("[avatars] lecture impossible :", err);
      return fail("Fichier manquant sur le serveur", 410, "GONE");
    }
  } catch (err) {
    return handleError(err);
  }
}
