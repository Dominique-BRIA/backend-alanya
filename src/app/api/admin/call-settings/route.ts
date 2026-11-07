import { env } from "@/lib/env";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { ecrireReglage, lireReglage } from "@/lib/gestion/outils";
import { cloudflareConfigure } from "@/lib/turn-cloudflare";
import {
  CLE_REGLAGES_APPELS,
  REGLAGES_APPELS_DEFAUT,
  normaliserReglagesAppels,
  oublierReglagesAppels,
  type ReglagesAppels,
} from "@/lib/reglages-appels";

/**
 * GET / PUT /api/admin/call-settings — les réglages des appels (07/11/2026).
 *
 * `relaisPrincipal` : `cloudflare` (Cloudflare principal, nos relais en
 * secours) ou `nos_relais` (l'inverse). Voir `src/lib/reglages-appels.ts`.
 *
 * La réponse dit aussi ce qui est RÉELLEMENT disponible : un Cloudflare non
 * configuré sur le serveur ne peut pas porter d'appel, quel que soit l'ordre
 * choisi — la console doit le montrer plutôt que laisser croire le contraire.
 */
async function etat() {
  const r = await lireReglage(CLE_REGLAGES_APPELS, REGLAGES_APPELS_DEFAUT);
  return {
    ...normaliserReglagesAppels(r.valeur),
    cloudflareConfigure: cloudflareConfigure(),
    nosRelais: env.coturn.domains(),
    modifieLe: r.modifieLe,
    modifiePar: r.modifiePar,
  };
}

export const GET = routeAdmin("settings.read", async () => okAdmin(await etat()));

export const PUT = routeAdmin("settings.write", async (req, session) => {
  const corps = ((await req.json().catch(() => null)) ?? {}) as { relaisPrincipal?: unknown };
  const actuel = normaliserReglagesAppels((await lireReglage(CLE_REGLAGES_APPELS, REGLAGES_APPELS_DEFAUT)).valeur);
  const suivant: ReglagesAppels = { ...actuel };
  if (corps.relaisPrincipal !== undefined) {
    if (corps.relaisPrincipal !== "cloudflare" && corps.relaisPrincipal !== "nos_relais") {
      throw new ErreurAdmin(400, "Relais principal inconnu", "FIELD_INVALID");
    }
    suivant.relaisPrincipal = corps.relaisPrincipal;
  }
  session.audit = {
    motif:
      suivant.relaisPrincipal === "cloudflare"
        ? "relais principal : Cloudflare"
        : "relais principal : nos relais",
  };
  await ecrireReglage(CLE_REGLAGES_APPELS, suivant, session);
  oublierReglagesAppels();
  return okAdmin(await etat());
});
