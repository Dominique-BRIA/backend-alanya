import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { recevoirPistes } from "@/lib/sfu-cloudflare";
import { lireNomPiste, maSession, pistesStockees } from "@/lib/sfu-routes";

/**
 * POST /api/sfu/sessions/:id/recevoir (07/11/2026)
 *   `{ pistes: [{ userId, nom }] }` → `{ offre | null, pistes: [{ mid, userId, nom }] }`
 *
 * Demande à recevoir des pistes publiées par d'autres membres de la MÊME
 * salle. Le client ne connaît que des comptes : c'est ici qu'on retrouve leur
 * session ouverte — jamais une session d'une autre salle.
 *
 * Quand `offre` est rendue, le client y répond par `/renegocier`. Chaque piste
 * revient avec le `mid` sous lequel elle arrivera dans sa connexion : c'est
 * ce qui lui dit à qui appartient chaque image et chaque voix. Une piste
 * introuvable (participant reparti, pas encore publiée) est simplement absente.
 */
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const { session } = await maSession(id, userId);
  const corps = ((await req.json().catch(() => null)) ?? {}) as { pistes?: unknown };

  const demandees = (Array.isArray(corps.pistes) ? corps.pistes.slice(0, 64) : []).map((p) => {
    const e = p as { userId?: unknown; nom?: unknown };
    return { userId: typeof e.userId === "string" ? e.userId : "", nom: lireNomPiste(e.nom) };
  });
  const auteurs = [...new Set(demandees.map((d) => d.userId).filter((u) => u && u !== userId))];
  if (auteurs.length === 0) return ok({ offre: null, pistes: [] });

  // La session ouverte la plus récente de chaque auteur, dans cette salle.
  const sessions = await prisma.sfuSession.findMany({
    where: { salle: session.salle, userId: { in: auteurs }, fermeLe: null },
    orderBy: { creeLe: "desc" },
  });
  const parAuteur = new Map<string, (typeof sessions)[number]>();
  for (const s of sessions) if (!parAuteur.has(s.userId)) parAuteur.set(s.userId, s);

  const aDemander: { sessionId: string; nom: string; userId: string }[] = [];
  for (const d of demandees) {
    const s = parAuteur.get(d.userId);
    if (!s || !pistesStockees(s.pistes).some((p) => p.nom === d.nom)) continue;
    aDemander.push({ sessionId: s.sessionId, nom: d.nom, userId: d.userId });
  }
  if (aDemander.length === 0) return ok({ offre: null, pistes: [] });

  const r = await recevoirPistes(
    session.sessionId,
    aDemander.map((d) => ({ sessionId: d.sessionId, nom: d.nom })),
  );
  const auteurDeSession = new Map(aDemander.map((d) => [d.sessionId, d.userId]));
  return ok({
    offre: r.offre,
    pistes: r.pistes
      .filter((p) => !p.erreur && p.mid)
      .map((p) => ({ mid: p.mid, userId: auteurDeSession.get(p.sessionId) ?? "", nom: p.nom }))
      .filter((p) => p.userId),
  });
});
