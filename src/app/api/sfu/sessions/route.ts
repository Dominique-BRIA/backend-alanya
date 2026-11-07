import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { creerSession } from "@/lib/sfu-cloudflare";
import { salleAutorisee } from "@/lib/sfu-routes";
import { cleSalle } from "@/lib/sfu-salle";

/**
 * POST /api/sfu/sessions — `{ salle }` → `{ sessionId }` (07/11/2026).
 *
 * Ouvre la connexion de l'appelant au SFU pour cette salle (`call:<id>` ou
 * `meeting:<id>`). Ses sessions précédentes dans la même salle sont closes :
 * un participant qui revient (réseau coupé, application relancée) ne doit pas
 * laisser derrière lui des pistes que les autres iraient chercher en vain.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const corps = ((await req.json().catch(() => null)) ?? {}) as { salle?: unknown };
  const salle = await salleAutorisee(corps.salle, userId);
  const cle = cleSalle(salle);

  const sessionId = await creerSession();
  await prisma.$transaction([
    prisma.sfuSession.updateMany({
      where: { salle: cle, userId, fermeLe: null },
      data: { fermeLe: new Date() },
    }),
    prisma.sfuSession.create({ data: { sessionId, salle: cle, userId } }),
  ]);
  return ok({ sessionId }, 201);
});
