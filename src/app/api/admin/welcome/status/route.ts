import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { ecrireStatutBienvenue, lireStatutBienvenue } from "@/lib/gestion/statut-bienvenue";

/** GET /api/admin/welcome/status — interrupteur et éléments du statut de bienvenue. */
export const GET = routeAdmin("welcome.read", async () => okAdmin(await lireStatutBienvenue()));

/**
 * PUT /api/admin/welcome/status — `{ enabled, blocks }`. Prend effet
 * immédiatement, sans « Publier » : c'est un réglage, pas une version.
 */
export const PUT = routeAdmin("welcome.status", async (req, session) =>
  okAdmin(await ecrireStatutBienvenue(await req.json().catch(() => null), session)),
);
