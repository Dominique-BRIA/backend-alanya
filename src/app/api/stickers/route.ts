import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { packsPublies } from "@/lib/gestion/stickers";

/**
 * GET /api/stickers — les packs publiés depuis la console, et leurs images.
 * `enabled: false` tant que la console n'a pas ouvert les stickers.
 */
export const GET = withAuth(async () => ok(await packsPublies()));
