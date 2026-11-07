import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { renegocier } from "@/lib/sfu-cloudflare";
import { lireDescription, maSession } from "@/lib/sfu-routes";

/**
 * PUT /api/sfu/sessions/:id/renegocier — `{ reponse }` (07/11/2026).
 *
 * La réponse du client à l'offre que Cloudflare a rendue par `/recevoir` ou
 * `/fermer`.
 */
export const PUT = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const { session } = await maSession(id, userId);
  const corps = ((await req.json().catch(() => null)) ?? {}) as { reponse?: unknown };
  await renegocier(session.sessionId, lireDescription(corps.reponse, "answer"));
  return ok({ ok: true });
});
