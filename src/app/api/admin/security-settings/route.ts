import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";

/**
 * GET /api/admin/security-settings — la liaison au téléphone.
 *
 * Chez nous, elle est TOUJOURS active (`src/lib/telephone-lie.ts`, 28/09/2026) :
 * un compte lié à un téléphone ne se connecte pas depuis un autre. Il n'y a
 * pas d'interrupteur global, et la console n'en invente pas.
 */
export const GET = routeAdmin("settings.read", async () =>
  okAdmin({ deviceBindingEnabled: true, updatedAt: "2026-09-28T00:00:00.000Z", modifiable: false }),
);

export const PUT = routeAdmin("settings.write", async () => {
  throw new ErreurAdmin(400, "La liaison au téléphone est toujours active", "NOT_SUPPORTED");
});
