import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { creerPack, listerPacks } from "@/lib/gestion/stickers";

/** GET /api/admin/sticker-packs?status&q */
export const GET = routeAdmin("stickers.read", async (req) => okAdmin({ packs: await listerPacks(req.nextUrl.searchParams) }));

/** POST — `{ code?, name_i18n, description_i18n?, author?, is_premium?, sort_order? }` → `{ id, code }`. */
export const POST = routeAdmin("stickers.write", async (req) => okAdmin(await creerPack(await req.json().catch(() => null)), 201));
