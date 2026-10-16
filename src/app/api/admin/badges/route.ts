import { z } from "zod";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { ecrireReglage } from "@/lib/gestion/outils";
import { env } from "@/lib/env";
import {
  apparenceSchema,
  BADGES_PAR_DEFAUT,
  CLE_REGLAGE_BADGES,
  lireApparences,
  oublierApparences,
  TYPES_BADGE,
} from "@/lib/badges";

/**
 * Les badges affichés à côté des noms (`src/lib/badges.ts`) : leur image, leur
 * libellé, et s'ils sont affichés. Les clients dessinent ce que dit ce réglage
 * — aucune mise à jour de l'application pour le changer.
 */
async function etat() {
  const a = await lireApparences();
  return {
    baseUrl: env.publicBaseUrl,
    badges: TYPES_BADGE.map((type) => ({ type, ...a[type], defaut: BADGES_PAR_DEFAUT[type] })),
  };
}

export const GET = routeAdmin("verifications.read", async () => okAdmin(await etat()));

const corpsSchema = z.object({ badges: z.record(z.enum(TYPES_BADGE), apparenceSchema) });

/** PUT — `{ badges: { officiel?: {actif, image, libelle}, verifie?: {…} } }`. */
export const PUT = routeAdmin("verifications.decide", async (req, session) => {
  const r = corpsSchema.safeParse(await req.json().catch(() => null));
  if (!r.success) {
    throw new ErreurAdmin(400, r.error.issues[0]?.message ?? "Réglage invalide", "VALIDATION");
  }
  const actuel = await lireApparences();
  await ecrireReglage(CLE_REGLAGE_BADGES, { ...actuel, ...r.data.badges }, session);
  oublierApparences();
  return okAdmin(await etat());
});
