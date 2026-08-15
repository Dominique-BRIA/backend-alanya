import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { centresDeLAgent } from "@/lib/queue-agents";

/**
 * GET /api/queue/agent-status — l'appelant est-il agent d'au moins un
 * centre ? Sert UNIQUEMENT à décider si un client doit MONTRER le menu
 * « Clients abandonnés » (demande user 15/08/2026 : un non-agent ne doit
 * rien voir, pas même un message « réservé »). La protection réelle des
 * données reste sur /api/queue/live et /api/queue/history (403 sinon) —
 * cet endpoint ne renvoie aucune donnée client, seulement des identifiants
 * de centre déjà publics pour un agent qui en fait partie.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const centres = await centresDeLAgent(userId);
  return ok({ isAgent: centres.length > 0, centerAlanyaIDs: centres });
});
