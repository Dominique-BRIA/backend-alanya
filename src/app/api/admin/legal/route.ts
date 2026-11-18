import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { SLUGS_LEGAUX, lirePageLegale } from "@/lib/pages-legales";

/** GET /api/admin/legal — les pages légales, pour l'éditeur de la console (18/11/2026). */
export const GET = routeAdmin("settings.read", async () =>
  okAdmin(await Promise.all(SLUGS_LEGAUX.map((s) => lirePageLegale(s)))),
);
