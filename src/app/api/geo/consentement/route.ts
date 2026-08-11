import { type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

const schema = z.object({ accepte: z.boolean() });

/**
 * POST /api/geo/consentement — l'utilisateur accepte ou refuse le suivi.
 *
 * ⚠️ CETTE ROUTE EXISTE POUR TENIR UNE PROMESSE. L'écran de divulgation annonce
 * que « votre entreprise sera informée que le suivi n'est pas actif ». Tant que
 * la décision ne vivait que dans les préférences du téléphone, le serveur ne
 * l'apprenait jamais et cette phrase ne valait rien.
 *
 * Le REFUS est l'information la plus utile des deux : un compte sans relevé peut
 * l'être parce qu'il a refusé, parce que son GPS est coupé, ou parce qu'il n'a
 * pas ouvert l'application depuis deux jours. Sans cette table, l'entreprise ne
 * pouvait pas faire la différence — et le silence a trois causes très
 * différentes.
 *
 * Idempotent : la décision se ré-affirme à chaque connexion, et écrase la
 * précédente. Un utilisateur qui change d'avis n'a rien de plus à faire.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const { accepte } = schema.parse(await req.json());
  await prisma.geoConsentement.upsert({
    where: { userId },
    create: { userId, accepte },
    update: { accepte, decideAt: new Date() },
  });
  return ok({ accepte });
});
