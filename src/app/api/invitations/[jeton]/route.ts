import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { areBlocked } from "@/lib/blocking";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { JETON_REGEX, etatInvitation } from "@/lib/invitation-qr";

// GET /api/invitations/<jeton> — ce qu'il faut pour la fiche de confirmation,
// SANS utiliser l'invitation.
//
// Réponse : { createur: { pseudo, avatarUrl }, expireLe, estLaMienne,
//             dejaContact, dejaUtiliseeParMoi }
//
// 🔒 L'Alanya ID du créateur n'est PAS rendu : l'invitation ne le révèle
// qu'une fois utilisée (décision du user). Le nom et la photo suffisent à
// reconnaître la personne avant d'accepter.
export const GET = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { jeton } = await ctx.params;
  if (!JETON_REGEX.test(jeton)) {
    return fail("Invitation introuvable", 404, "INVITATION_INCONNUE");
  }

  const inv = await prisma.invitationQr.findUnique({
    where: { jeton },
    include: { createur: true },
  });
  if (!inv) return fail("Invitation introuvable", 404, "INVITATION_INCONNUE");

  const dejaUtiliseeParMoi = inv.utiliseePar === userId;
  const etat = etatInvitation(inv);
  // Utilisée par moi : on rend la fiche quand même, pour qu'un second clic
  // sur le même lien rouvre la conversation au lieu d'afficher une erreur.
  if (etat === "utilisee" && !dejaUtiliseeParMoi) {
    return fail("Cette invitation a déjà été utilisée", 410, "INVITATION_UTILISEE");
  }
  if (etat === "expiree" && !dejaUtiliseeParMoi) {
    return fail("Cette invitation a expiré", 410, "INVITATION_EXPIREE");
  }

  const estLaMienne = inv.createurId === userId;
  if (!estLaMienne && (await areBlocked(userId, inv.createurId))) {
    // Message neutre : ne dit pas QUI a bloqué qui.
    return fail("Cette invitation n'est pas disponible", 403, "INVITATION_INDISPONIBLE");
  }

  const contact = estLaMienne
    ? null
    : await prisma.contact.findUnique({
        where: { userId_contactId: { userId, contactId: inv.createurId } },
        select: { id: true },
      });

  return ok({
    createur: {
      pseudo: nomAffichage(inv.createur),
      avatarUrl: avatarPublicUrl(inv.createur.avatarUrl ?? null),
    },
    expireLe: inv.expireLe.toISOString(),
    estLaMienne,
    dejaContact: Boolean(contact),
    dejaUtiliseeParMoi,
  });
});
