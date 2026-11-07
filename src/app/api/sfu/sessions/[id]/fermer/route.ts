import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, HttpError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { fermerPistes } from "@/lib/sfu-cloudflare";

/**
 * POST /api/sfu/sessions/:id/fermer (07/11/2026)
 *   `{ mids }` → `{ offre | null }` : cesser de recevoir ces pistes (un
 *   participant est parti).
 *   `{ tout: true }` → la session est close de notre côté : on raccroche.
 *
 * Volontairement plus permissive que les autres routes : un participant qui
 * vient de quitter l'appel doit encore pouvoir fermer sa propre session.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const s = await prisma.sfuSession.findUnique({ where: { sessionId: id } });
  if (!s || s.userId !== userId) throw new HttpError(404, "Session introuvable", "NOT_FOUND");

  const corps = ((await req.json().catch(() => null)) ?? {}) as { mids?: unknown; tout?: unknown };
  if (corps.tout === true) {
    if (!s.fermeLe) {
      await prisma.sfuSession.update({ where: { sessionId: id }, data: { fermeLe: new Date() } });
    }
    return ok({ offre: null });
  }
  if (s.fermeLe) return ok({ offre: null });

  const mids = (Array.isArray(corps.mids) ? corps.mids.slice(0, 64) : []).filter(
    (m): m is string => typeof m === "string" && /^[0-9a-zA-Z_-]{1,16}$/.test(m),
  );
  return ok(await fermerPistes(s.sessionId, mids));
});
