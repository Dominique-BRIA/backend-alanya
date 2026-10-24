import { env } from "@/lib/env";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { ecrireReglage, lireReglage } from "@/lib/gestion/outils";
import { CLE_REGLAGES_PLATEFORME, oublierMaintenance } from "@/lib/maintenance";

/**
 * GET / PUT /api/admin/settings — `{ maintenance, appName, apiUrl }`, comme
 * chez Alanya2026 (`controllers/admin/settings.js`).
 *
 * 🔁 24/10/2026 : le mode maintenance est RÉEL (décision du user) — chez eux
 * l'interrupteur s'enregistrait sans que rien ne le lise. Voir
 * `src/lib/maintenance.ts` pour ce qu'il bloque, et ce qu'il laisse passer.
 */
const defaut = () => ({ maintenance: false, appName: "Alanya Work", apiUrl: env.publicBaseUrl });

export const GET = routeAdmin("settings.read", async () => okAdmin((await lireReglage(CLE_REGLAGES_PLATEFORME, defaut())).valeur));

export const PUT = routeAdmin("settings.write", async (req, session) => {
  const corps = ((await req.json().catch(() => null)) ?? {}) as { maintenance?: unknown; appName?: unknown; apiUrl?: unknown };
  const actuel = (await lireReglage(CLE_REGLAGES_PLATEFORME, defaut())).valeur;
  const suivant = { ...actuel };
  if (typeof corps.maintenance === "boolean") suivant.maintenance = corps.maintenance;
  if (typeof corps.appName === "string") {
    if (!corps.appName.trim()) throw new ErreurAdmin(400, "Le nom de l'application ne peut pas être vide", "FIELD_EMPTY");
    suivant.appName = corps.appName.trim().slice(0, 60);
  }
  if (typeof corps.apiUrl === "string") suivant.apiUrl = corps.apiUrl.trim().slice(0, 200);
  session.audit = { motif: typeof corps.maintenance === "boolean" ? `maintenance ${corps.maintenance ? "activée" : "levée"}` : null };
  await ecrireReglage(CLE_REGLAGES_PLATEFORME, suivant, session);
  oublierMaintenance();
  return okAdmin(suivant);
});
