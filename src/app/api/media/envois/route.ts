import { type NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { isAllowedMime } from "@/modules/media/storage";
import { lireEmpreinte } from "@/lib/envoi-morceaux.mjs";
import { reserverEnvoi } from "@/modules/media/envois-morceaux";

const demandeSchema = z.object({
  taille: z.number().int().positive(),
  nom: z.string().min(1).max(1000),
  mime: z.string().max(255).optional(),
  chiffre: z.boolean().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  /** SHA-256 (hex) du fichier entier, vérifié à l'assemblage. */
  empreinte: z.string().optional(),
});

/**
 * POST /api/media/envois — RÉSERVE un envoi en morceaux.
 *
 * Rend l'identifiant, le JETON D'ENVOI (à présenter dans `X-Envoi-Jeton` pour
 * chaque morceau) et le découpage décidé par le serveur. Voir
 * `src/modules/media/envois-morceaux.ts`.
 *
 * ⚠️ LE SERVEUR DÉCIDE DE LA TAILLE D'UN MORCEAU, PAS LE CLIENT : on peut la
 * changer dans le `.env` sans attendre que chaque téléphone soit mis à jour.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const corps = demandeSchema.parse(await req.json());

  // Mêmes règles d'admission que `POST /api/media`.
  const mime = corps.mime || "application/octet-stream";
  if (!isAllowedMime(mime)) {
    return fail(`Type de fichier non autorisé : ${mime}`, 415, "BAD_MIME");
  }
  if (corps.taille > env.media.maxSizeMb * 1024 * 1024) {
    return fail(`Fichier trop volumineux (max ${env.media.maxSizeMb} Mo)`, 413, "TOO_LARGE");
  }
  const empreinte = lireEmpreinte(corps.empreinte);
  if (empreinte === null) {
    return fail("Empreinte SHA-256 attendue en hexadécimal", 422, "EMPREINTE_INVALIDE");
  }

  const reservation = await reserverEnvoi(userId, {
    taille: corps.taille,
    nom: corps.nom,
    mime,
    chiffre: corps.chiffre === true,
    dureeMs: corps.durationMs ?? null,
    empreinte: empreinte ?? null,
  });
  return ok(reservation, 201);
});
