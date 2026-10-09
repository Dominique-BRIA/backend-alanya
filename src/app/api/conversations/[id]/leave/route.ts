import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { invaliderConversation } from "@/lib/cache-redis.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { deposerMessageSysteme, nomPourAvis } from "@/lib/messages-systeme";
import { MEMBRE_ACTIF, donneesDepart } from "@/lib/appartenance.mjs";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";

// POST /api/conversations/:id/leave — quitter un groupe.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    include: { participants: { where: MEMBRE_ACTIF } },
  });
  if (!conv) return fail("Conversation introuvable", 404, "NOT_FOUND");
  if (!conv.isGroup) return fail("Ce n'est pas un groupe", 400, "NOT_GROUP");

  const participant = conv.participants.find((p) => p.userId === userId);
  if (!participant) return fail("Vous n'êtes pas membre de ce groupe", 404, "NOT_MEMBER");

  // Nom lu AVANT la suppression : après, le participant n'est plus là.
  const nomPartant = await nomPourAvis(userId);

  // Départ MARQUÉ, pas effacé (09/10/2026, `appartenance.mjs`) ; la copie
  // personnelle du trousseau d'un groupe chiffré part avec.
  await prisma.$transaction([
    prisma.participant.update({
      where: { convId_userId: { convId, userId } },
      data: donneesDepart(null),
    }),
    prisma.e2eeTrousseau.deleteMany({ where: { convId, userId } }),
  ]);
  // Même raison qu'au retrait : la liste des membres décide de qui reçoit quoi.
  await invaliderConversation(convId);

  /*
   * 🔴 LE PARTANT EFFACE SON TROUSSEAU (groupe chiffré, décision du user). Ses
   * appareils sont prévenus ici ; les messages DÉJÀ LUS restent chez lui,
   * comme sur WhatsApp. Pas de nouvelle clé pour un départ volontaire ; pour
   * une exclusion, c'est l'appareil de l'administrateur qui la crée
   * (`e2ee/versions`).
   */
  if (conv.e2eeActif) {
    await previensDesPersonnes({
      personnes: [userId],
      type: "e2ee_membre_parti",
      donnees: { convId, exclu: false },
    });
  }

  // Si le groupe n'a plus de membres, supprime la conversation
  const remaining = await prisma.participant.count({ where: { convId, ...MEMBRE_ACTIF } });
  if (remaining === 0) {
    await prisma.conversation.delete({ where: { id: convId } });
    return ok({ message: "Groupe supprimé (plus de membres)", deleted: true });
  }

  // Départ volontaire : aucun auteur mentionné, contrairement au retrait.
  // Déposé seulement si le groupe existe encore — supprimé, l'avis n'aurait
  // plus de fil où vivre.
  await deposerMessageSysteme(convId, userId, "member_left", { target: nomPartant });

  return ok({ message: "Vous avez quitté le groupe", deleted: false });
});
