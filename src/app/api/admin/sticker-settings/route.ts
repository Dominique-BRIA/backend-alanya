import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { ecrireReglages, lireReglages } from "@/lib/gestion/stickers";

/** Les réglages de lancement des stickers (fermés par défaut). */
export const GET = routeAdmin("stickers.read", async () => okAdmin(await lireReglages()));

/** PUT — `{ enabled?, creation_enabled?, animated_enabled?, min_app_version? }`. */
export const PUT = routeAdmin("stickers.settings", async (req, session) =>
  okAdmin(await ecrireReglages(await req.json().catch(() => null), session)),
);
