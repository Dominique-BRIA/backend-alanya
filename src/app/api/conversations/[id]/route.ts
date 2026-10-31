import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { avatarStockage } from "@/lib/avatar";
import { apresChangementDePhoto } from "@/lib/avatar-profil";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { estAdminDuGroupe } from "@/lib/groupe-droits.mjs";
import { invaliderConversation } from "@/lib/cache-redis.mjs";

/** Les quatre réglages du groupe (01/11/2026), réservés aux admins. */
const REGLAGES = [
  "adminsSeulsEcrivent",
  "adminsSeulsModifient",
  "adminsSeulsAjoutent",
  "historiqueCacheNouveaux",
] as const;

/*
 * PATCH /api/conversations/:id — modifier un groupe.
 *
 *  - nom, photo, description : les admins ; TOUT MEMBRE si le groupe a levé
 *    « seuls les admins modifient » (01/11/2026, repris d'Alanya2026) ;
 *  - les réglages du groupe : les admins, toujours.
 */
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  const body = await req.json();

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: { where: MEMBRE_ACTIF, orderBy: { joinedAt: "asc" } } },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  const me = conv.participants.find((p) => p.userId === userId);
  if (!me) return fail("Accès refusé", 403, "FORBIDDEN");
  const isAdmin = estAdminDuGroupe(conv.participants, userId);

  const data: Record<string, unknown> = {};
  const touchesInfos =
    body.name !== undefined || body.avatarUrl !== undefined || body.description !== undefined;
  if (touchesInfos && conv.adminsSeulsModifient && !isAdmin) {
    return fail("Seul un admin peut modifier le groupe", 403, "NOT_ADMIN");
  }
  if (body.name !== undefined) data.name = body.name;
  if (body.avatarUrl !== undefined) data.avatarUrl = avatarStockage(body.avatarUrl);
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      return fail("Description invalide", 400, "BAD_DESCRIPTION");
    }
    const d = typeof body.description === "string" ? body.description.trim().slice(0, 512) : "";
    data.description = d === "" ? null : d;
  }

  const reglages = REGLAGES.filter((k) => body[k] !== undefined);
  if (reglages.length > 0) {
    if (!isAdmin) return fail("Seul un admin peut changer les réglages du groupe", 403, "NOT_ADMIN");
    for (const k of reglages) {
      if (typeof body[k] !== "boolean") return fail(`« ${k} » doit être un booléen`, 400, "BAD_SETTING");
      data[k] = body[k];
    }
  }

  if (Object.keys(data).length === 0) {
    return fail("Aucune modification", 400, "NO_CHANGES");
  }

  const maj = await prisma.conversation.update({
    where: { id: convId },
    data,
  });
  // Le mode annonce est lu à chaque envoi : la copie en cache doit suivre.
  await invaliderConversation(convId);

  // La nouvelle photo du groupe part dans le seau public, l'ancienne en sort.
  if (data.avatarUrl !== undefined) apresChangementDePhoto(conv.avatarUrl, data.avatarUrl as string | null);

  return ok({
    message: "Groupe mis à jour",
    id: convId,
    description: maj.description,
    adminsSeulsEcrivent: maj.adminsSeulsEcrivent,
    adminsSeulsModifient: maj.adminsSeulsModifient,
    adminsSeulsAjoutent: maj.adminsSeulsAjoutent,
    historiqueCacheNouveaux: maj.historiqueCacheNouveaux,
  });
});
