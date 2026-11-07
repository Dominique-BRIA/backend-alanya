import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, HttpError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { publierPistes } from "@/lib/sfu-cloudflare";
import { lireDescription, lirePistes, maSession, pistesStockees, type PisteSfu } from "@/lib/sfu-routes";
import { cleSalle, membresDeLaSalle } from "@/lib/sfu-salle";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";

/**
 * POST /api/sfu/sessions/:id/publier (07/11/2026)
 *   `{ offre, pistes: [{ mid, nom, genre }] }` → `{ reponse }`
 *
 * Publie les pistes locales du client (micro, caméra). Les autres membres de
 * la salle en sont prévenus par la trame `sfu_pistes`, et vont les chercher
 * par `/recevoir`.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const { session, salle } = await maSession(id, userId);
  const corps = ((await req.json().catch(() => null)) ?? {}) as { offre?: unknown; pistes?: unknown };
  const offre = lireDescription(corps.offre, "offer");

  const brutes = Array.isArray(corps.pistes) ? corps.pistes.slice(0, 8) : [];
  const genres = lirePistes(brutes);
  const pistes = brutes.map((p, i) => {
    const mid = (p as { mid?: unknown }).mid;
    if (typeof mid !== "string" || !/^[0-9a-zA-Z_-]{1,16}$/.test(mid)) {
      throw new HttpError(400, "mid invalide", "BAD_TRACK");
    }
    return { mid, ...genres[i] };
  });
  if (pistes.length === 0) throw new HttpError(400, "Aucune piste à publier", "BAD_TRACK");

  const r = await publierPistes(session.sessionId, offre, pistes.map((p) => ({ mid: p.mid, nom: p.nom })));

  // Les pistes publiées, par nom : une publication suivante (passage en vidéo)
  // s'ajoute à celles d'avant au lieu de les remplacer.
  const refusees = new Set(r.pistes.filter((p) => p.erreur).map((p) => p.nom));
  const nouvelles: PisteSfu[] = pistes.filter((p) => !refusees.has(p.nom)).map(({ nom, genre }) => ({ nom, genre }));
  const parNom = new Map(pistesStockees(session.pistes).map((p) => [p.nom, p]));
  for (const p of nouvelles) parNom.set(p.nom, p);
  const toutes = [...parNom.values()];
  await prisma.sfuSession.update({ where: { sessionId: session.sessionId }, data: { pistes: toutes } });

  const autres = (await membresDeLaSalle(salle)).filter((u) => u !== userId);
  if (autres.length > 0 && nouvelles.length > 0) {
    await previensDesPersonnes({
      personnes: autres,
      type: "sfu_pistes",
      donnees: { salle: cleSalle(salle), userId, pistes: nouvelles },
    });
  }

  return ok({ reponse: r.reponse, refusees: [...refusees] });
});
