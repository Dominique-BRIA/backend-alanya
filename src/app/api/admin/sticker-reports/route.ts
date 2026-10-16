import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { signalementsStickers } from "@/lib/gestion/stickers";

/** GET /api/admin/sticker-reports — les 200 derniers signalements de stickers. */
export const GET = routeAdmin("stickers.read", async () => okAdmin({ reports: await signalementsStickers() }));
