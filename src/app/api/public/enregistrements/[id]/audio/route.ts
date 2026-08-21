import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { readStored } from "@/modules/media/storage";

/**
 * GET /api/public/enregistrements/:id/audio — l'enregistrement MÉLANGÉ d'une
 * conversation agent ↔ client, SANS jeton.
 *
 * 🔴 **DÉLIBÉRÉMENT NON AUTHENTIFIÉE** — décision du user (21/08/2026), en
 * réponse à la question n° 4 de la note d'équipe, laissée ouverte le 20/08.
 * La plateforme de la collègue lit `call_recording` directement, comme elle le
 * fait déjà pour `voice_complaint`, `center_music` et `center_audio` : elle
 * trouve l'adresse dans `url_audio` et l'ouvre.
 *
 * ⚠️ **CE N'EST PAS UN CONTRÔLE D'ACCÈS, ET L'ENJEU EST PLUS GROS QU'UNE
 * PLAINTE.** Une plainte est une réclamation dictée par son auteur ; ici c'est
 * une CONVERSATION ENTIÈRE, à deux voix, dont le correspondant n'a jamais été
 * averti qu'elle était enregistrée (voir `POST /api/call-recordings`). Quiconque
 * connaît l'URL l'écoute. Sa seule protection est d'être indevinable — elle
 * porte l'UUID de l'enregistrement, tiré par `gen_random_uuid()`. C'est de
 * l'obscurité, pas une autorisation.
 *
 * ⚠️ **L'IDENTIFIANT EST CELUI DE L'ENREGISTREMENT, PAS DU MÉDIA.** Exposer
 * `media_files.id` aurait ouvert un second chemin vers TOUS les médias du
 * produit — photos, vocaux, documents — dès qu'un identifiant fuiterait. Ici,
 * seule une ligne de `call_recording` peut être servie, et rien d'autre.
 *
 * 🔴 **LE MÉLANGE SEUL, JAMAIS LES PISTES BRUTES.** Chacune des deux ne contient
 * QU'UNE voix — le micro de l'agent d'un côté, le distant de l'autre. Les servir
 * donnerait une conversation à trous que personne ne saurait interpréter. Elles
 * restent en base pour pouvoir REFAIRE le mélange, pas pour être écoutées.
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

  const enregistrement = await prisma.callRecording.findUnique({
    where: { idRecording: id },
    select: {
      statut: true,
      mediaMix: { select: { url: true, mimeType: true } },
    },
  });
  if (!enregistrement) return new Response("Introuvable", { status: 404 });

  /*
   * PAS ENCORE MÉLANGÉ : il n'y a rien à écouter, et ce n'est pas une panne.
   * Le mélange est lancé sans être attendu (`melangerEnregistrement`), il peut
   * prendre quelques secondes, et ffmpeg peut manquer sur le serveur.
   *
   * Un TEXTE DISTINCT du 404 d'un identifiant inconnu, parce que les deux cas
   * n'appellent pas la même conduite : ici, réessayer plus tard a un sens. Le
   * code reste 404 — du point de vue de l'appelant, il n'y a pas d'audio.
   *
   * En pratique la plateforme ne devrait jamais tomber là : `url_audio` et
   * `statut = 2` sont posés PAR LA MÊME requête, donc une adresse présente en
   * base est une adresse qui répond.
   */
  if (enregistrement.statut !== 2 || !enregistrement.mediaMix) {
    return new Response("Pas encore disponible", { status: 404 });
  }

  try {
    const octets = await readStored(enregistrement.mediaMix.url);
    return new Response(new Uint8Array(octets), {
      headers: {
        "Content-Type": enregistrement.mediaMix.mimeType || "audio/mp4",
        "Content-Length": String(octets.length),
        // `inline` : le navigateur JOUE le fichier au lieu de le télécharger.
        // C'est ce qu'attend un écran de consultation des enregistrements.
        "Content-Disposition": `inline; filename="appel-${id}.m4a"`,
        // Immuable : un enregistrement mélangé ne change plus. Le cache évite de
        // relire le disque à chaque écoute, et il n'y a rien à invalider.
        // ⚠️ Il ne porte QUE le mélange : une ligne encore en `statut != 2` sort
        // par le 404 ci-dessus, qui n'est jamais mis en cache.
        "Cache-Control": "public, max-age=31536000, immutable",
        // Nécessaire pour qu'un lecteur audio d'une AUTRE origine — la
        // plateforme de la collègue — puisse le lire.
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    console.error("[enregistrement-audio] lecture impossible", id, e);
    // 404 et non 500 : du point de vue de l'appelant, il n'y a rien à écouter.
    // Le motif réel est dans nos journaux.
    return new Response("Introuvable", { status: 404 });
  }
}
