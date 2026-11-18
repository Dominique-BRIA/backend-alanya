import { type NextRequest } from "next/server";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { enregistrerPageLegale, estSlugLegal, lirePageLegale } from "@/lib/pages-legales";

type Ctx = { params: Promise<{ slug: string }> };

async function slugDe(ctx: Ctx) {
  const { slug } = await ctx.params;
  if (!estSlugLegal(slug)) throw new ErreurAdmin(404, "Page inconnue", "NOT_FOUND");
  return slug;
}

/** GET /api/admin/legal/:slug — une page légale. */
export const GET = routeAdmin("settings.read", async (_req: NextRequest, _s, ctx: Ctx) =>
  okAdmin(await lirePageLegale(await slugDe(ctx))),
);

/**
 * PUT /api/admin/legal/:slug — enregistre une NOUVELLE VERSION { titre, contenu }.
 * Chaque enregistrement fait monter la version et passe au journal d'audit.
 */
export const PUT = routeAdmin("settings.write", async (req: NextRequest, session, ctx: Ctx) => {
  const slug = await slugDe(ctx);
  const corps = ((await req.json().catch(() => null)) ?? {}) as { titre?: unknown; contenu?: unknown };
  const titre = typeof corps.titre === "string" ? corps.titre.trim() : "";
  const contenu = typeof corps.contenu === "string" ? corps.contenu.trim() : "";
  if (!titre) throw new ErreurAdmin(400, "Le titre ne peut pas être vide", "FIELD_EMPTY");
  if (contenu.length < 50) throw new ErreurAdmin(400, "Le texte est trop court", "FIELD_EMPTY");
  if (titre.length > 200 || contenu.length > 100_000) {
    throw new ErreurAdmin(400, "Texte trop long", "TOO_LONG");
  }
  session.audit = { cibleType: "page_legale", cibleId: slug, motif: "nouvelle version" };
  return okAdmin(await enregistrerPageLegale(slug, titre, contenu, session.nom));
});
