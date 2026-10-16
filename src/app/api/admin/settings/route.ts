import { env } from "@/lib/env";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";

/**
 * GET /api/admin/settings — l'identité de la plateforme, en lecture.
 *
 * ⚠️ PAS DE MODE MAINTENANCE. La console d'origine en proposait un ; ici,
 * rien ne le ferait respecter par l'application, et un interrupteur sans
 * effet est pire que pas d'interrupteur. PUT est donc refusé.
 */
export const GET = routeAdmin("settings.read", async () =>
  okAdmin({ maintenance: false, appName: "Alanya Work", apiUrl: env.publicBaseUrl }),
);

export const PUT = routeAdmin("settings.write", async () => {
  throw new ErreurAdmin(400, "Ces réglages ne se modifient pas depuis la console", "NOT_SUPPORTED");
});
