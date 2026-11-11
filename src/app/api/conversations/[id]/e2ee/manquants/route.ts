import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { groupeChiffrePour, manquants } from "@/lib/e2ee-v2";

/**
 * GET /api/conversations/:id/e2ee/manquants — ce qu'il reste à emballer dans
 * ce groupe chiffré (chiffrement des groupes v2, 11/11/2026, conception § 5.6).
 *
 * `{ cleVersion, manquants: [{ userId, versionCompte, publique, versions }], sansCle }`
 *
 * Un appareil qui a les clés le demande à l'ouverture du groupe (et sur la
 * trame `e2ee_manquants`), puis dépose ce qu'il peut par `PUT /api/e2ee/emballages`.
 * Réservé aux membres actifs : la liste dit qui est membre et quelles
 * versions existent, rien de plus.
 */
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const conv = await groupeChiffrePour(id, userId);
  return ok(await manquants(conv.id, conv.cleVersion));
});
