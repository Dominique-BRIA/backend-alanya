import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { STATUT_BIENVENUE_DESACTIVE } from "@/lib/gestion/bienvenue";

/** Le statut de bienvenue est exclu (décision du 15/10/2026) : lu désactivé, jamais écrit. */
export const GET = routeAdmin("welcome.read", async () => okAdmin(STATUT_BIENVENUE_DESACTIVE));

export const PUT = routeAdmin("welcome.status", async () => {
  throw new ErreurAdmin(400, "Le statut de bienvenue n'est pas pris en charge", "NOT_SUPPORTED");
});
