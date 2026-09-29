import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { areBlocked } from "@/lib/blocking";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { JETON_REGEX, etatInvitation } from "@/lib/invitation-qr";

// POST /api/invitations/<jeton>/utiliser — utilise l'invitation : les deux
// personnes s'ajoutent mutuellement aux contacts, et la conversation directe
// est rendue.
//
// Réponse : { convId, user: { id, publicNumber, pseudo, avatarUrl, statusMsg } }
// — l'Alanya ID du créateur n'est révélé qu'ici, une fois l'invitation prise.
//
// Rejouable par celui qui l'a utilisée (double appui, réseau coupé avant la
// réponse) : il retrouve la même conversation au lieu d'une erreur.
export const POST = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { jeton } = await ctx.params;
  if (!JETON_REGEX.test(jeton)) {
    return fail("Invitation introuvable", 404, "INVITATION_INCONNUE");
  }

  const inv = await prisma.invitationQr.findUnique({
    where: { jeton },
    include: { createur: true },
  });
  if (!inv) return fail("Invitation introuvable", 404, "INVITATION_INCONNUE");

  const createurId = inv.createurId;
  if (createurId === userId) {
    return fail("C'est ta propre invitation", 400, "SELF");
  }
  if (await areBlocked(userId, createurId)) {
    return fail("Cette invitation n'est pas disponible", 403, "INVITATION_INDISPONIBLE");
  }

  const contactsMutuels = [
    { userId, contactId: createurId },
    { userId: createurId, contactId: userId },
  ];

  if (inv.utiliseePar === userId) {
    // Déjà prise par moi : on s'assure seulement que les contacts sont là.
    await prisma.contact.createMany({ data: contactsMutuels, skipDuplicates: true });
  } else {
    const etat = etatInvitation(inv);
    if (etat === "utilisee") {
      return fail("Cette invitation a déjà été utilisée", 410, "INVITATION_UTILISEE");
    }
    if (etat === "expiree") {
      return fail("Cette invitation a expiré", 410, "INVITATION_EXPIREE");
    }

    /*
     * 🔒 L'USAGE UNIQUE TIENT À CE SEUL `UPDATE`. Ses conditions sont
     * réévaluées par PostgreSQL sur la ligne verrouillée : de deux clics
     * simultanés, le second attend le premier, retrouve `utilisee_le` rempli
     * et ne modifie rien (count = 0). La lecture ci-dessus ne sert qu'à
     * choisir le message d'erreur, jamais à décider.
     *
     * Les contacts sont posés dans la MÊME transaction : si leur création
     * échoue, l'invitation n'est pas consommée pour rien.
     */
    const prise = await prisma.$transaction(async (tx) => {
      const r = await tx.invitationQr.updateMany({
        where: { jeton, utiliseeLe: null, expireLe: { gt: new Date() } },
        data: { utiliseeLe: new Date(), utiliseePar: userId },
      });
      if (r.count !== 1) return false;
      await tx.contact.createMany({ data: contactsMutuels, skipDuplicates: true });
      return true;
    });
    if (!prise) {
      return fail("Cette invitation a déjà été utilisée", 410, "INVITATION_UTILISEE");
    }
  }

  const conv = await findOrCreateDirectConversation(userId, createurId);
  const c = inv.createur;
  return ok({
    convId: conv.id,
    user: {
      id: c.id,
      publicNumber: c.publicNumber,
      pseudo: nomAffichage(c),
      avatarUrl: avatarPublicUrl(c.avatarUrl ?? null),
      statusMsg: c.statusMsg ?? null,
    },
  });
});
