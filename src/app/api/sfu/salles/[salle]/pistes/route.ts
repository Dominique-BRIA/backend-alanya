import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { pistesStockees, salleAutorisee } from "@/lib/sfu-routes";
import { cleSalle } from "@/lib/sfu-salle";

/**
 * GET /api/sfu/salles/:salle/pistes — `{ pistes: [{ userId, nom, genre }] }`
 * (07/11/2026).
 *
 * Ce que les AUTRES membres publient déjà dans la salle : celui qui arrive
 * n'a reçu aucune trame `sfu_pistes` pour eux, il les découvre ici.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { salle: brut } = await ctx.params;
  const salle = await salleAutorisee(decodeURIComponent(brut), userId);
  const sessions = await prisma.sfuSession.findMany({
    where: { salle: cleSalle(salle), fermeLe: null, userId: { not: userId } },
    orderBy: { creeLe: "desc" },
  });
  const vus = new Set<string>();
  const pistes: { userId: string; nom: string; genre: "audio" | "video" }[] = [];
  for (const s of sessions) {
    if (vus.has(s.userId)) continue;
    vus.add(s.userId);
    for (const p of pistesStockees(s.pistes)) pistes.push({ userId: s.userId, nom: p.nom, genre: p.genre });
  }
  return ok({ pistes });
});
