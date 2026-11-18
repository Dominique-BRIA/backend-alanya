import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { estSlugLegal, lirePageLegale } from "@/lib/pages-legales";

/**
 * GET /api/legal/:slug — une page légale, SANS CONNEXION (18/11/2026).
 *
 * `confidentialite` ou `conditions`. Publique par nature : Google la lit
 * depuis la fiche du Play Store, et on doit pouvoir la consulter avant de
 * créer un compte.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!estSlugLegal(slug)) return fail("Page inconnue", 404, "NOT_FOUND");
  return ok(await lirePageLegale(slug));
}
