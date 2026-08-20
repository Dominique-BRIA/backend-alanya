import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { readStored } from "@/modules/media/storage";

/**
 * GET /api/public/plaintes/:id/audio — l'audio d'une plainte vocale, SANS jeton.
 *
 * 🔴 **DÉLIBÉRÉMENT NON AUTHENTIFIÉE** — décision du user (20/08/2026). La
 * plateforme de la collègue lit `voice_complaint` directement, comme elle le
 * fait déjà pour `center_music` et `center_audio` ; lui imposer notre mécanisme
 * de jetons pour un seul écran serait disproportionné. Elle lit `url_audio`
 * dans la ligne et l'ouvre.
 *
 * ⚠️ **CE N'EST PAS UN CONTRÔLE D'ACCÈS.** Quiconque connaît l'URL écoute la
 * plainte. Sa seule protection est d'être indevinable : elle porte l'UUID de la
 * plainte, tiré au hasard par `gen_random_uuid()`. C'est le compromis habituel
 * pour du média, et il faut le savoir avant d'y faire passer autre chose que des
 * réclamations.
 *
 * ⚠️ **L'IDENTIFIANT EST CELUI DE LA PLAINTE, PAS DU MÉDIA.** Exposer
 * `media_files.id` aurait ouvert un second chemin vers TOUS les médias du
 * produit — photos, vocaux, documents — dès qu'un identifiant fuiterait. Ici,
 * seule une ligne de `voice_complaint` peut être servie, et rien d'autre.
 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  // Forme vérifiée AVANT la requête : une chaîne quelconque ferait lever Prisma
  // sur un UUID invalide, et le 500 ressemblerait à une panne du serveur.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return new Response("Introuvable", { status: 404 });
  }

  const plainte = await prisma.voiceComplaint.findUnique({
    where: { idComplaint: id },
    select: { media: { select: { url: true, mimeType: true, sizeBytes: true } } },
  });
  if (!plainte) return new Response("Introuvable", { status: 404 });

  try {
    const octets = await readStored(plainte.media.url);
    return new Response(new Uint8Array(octets), {
      headers: {
        "Content-Type": plainte.media.mimeType || "audio/mp4",
        "Content-Length": String(octets.length),
        // `inline` : le navigateur JOUE le fichier au lieu de le télécharger.
        // C'est ce qu'attend un écran de traitement des plaintes.
        "Content-Disposition": `inline; filename="plainte-${id}.m4a"`,
        // Immuable : une plainte ne change jamais. Le cache évite de relire le
        // disque à chaque écoute, et il n'y a rien à invalider.
        "Cache-Control": "public, max-age=31536000, immutable",
        // Nécessaire pour qu'un lecteur audio d'une AUTRE origine — la
        // plateforme de la collègue — puisse le lire.
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    console.error("[plainte-audio] lecture impossible", id, e);
    // 404 et non 500 : du point de vue de l'appelant, il n'y a rien à écouter.
    // Le motif réel est dans nos journaux.
    return new Response("Introuvable", { status: 404 });
  }
}
