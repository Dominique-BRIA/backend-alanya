import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { updateContactSchema } from "@/lib/validation";
import { setBlockRow } from "@/lib/blocking";

// PATCH /api/contacts/:id — met à jour un contact (alias, blocage).
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const data = updateContactSchema.parse(await req.json());

  const contact = await prisma.contact.findUnique({
    where: { id },
    include: { contact: { select: { nomVerrouille: true } } },
  });
  if (!contact || contact.userId !== userId) {
    return fail("Contact introuvable", 404, "NOT_FOUND");
  }

  /*
   * Le nom donné : une chaîne vide ou `null` l'EFFACE (on revient au nom du
   * profil). 🐛 Avant, `null` devenait `undefined` : impossible d'effacer.
   *
   * 🔴 UN COMPTE QUI REFUSE D'ÊTRE RENOMMÉ (`nomVerrouille`) : on peut effacer,
   * jamais poser un nom (18/10/2026).
   */
  const alias =
    data.alias === undefined ? undefined : data.alias?.trim() ? data.alias.trim() : null;
  if (alias && contact.contact.nomVerrouille) {
    return fail(
      "Cette personne ne permet pas qu'on lui donne un autre nom",
      409,
      "NOM_VERROUILLE",
    );
  }

  const updated = await prisma.contact.update({
    where: { id },
    data: {
      alias,
      isBlocked: data.isBlocked ?? undefined,
    },
  });

  // Unification : le flag Contact.isBlocked est un miroir ; la source de vérité
  // est la table Blocked. On synchronise pour que la fiche contact et l'écran
  // Réglages > Bloqués restent cohérents et que le blocage soit appliqué.
  if (data.isBlocked !== undefined) {
    await setBlockRow(userId, contact.contactId, data.isBlocked);
  }

  return ok({ id: updated.id, alias: updated.alias, isBlocked: updated.isBlocked });
});

// DELETE /api/contacts/:id — retire un contact du répertoire.
export const DELETE = withAuth(async (_req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;

  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact || contact.userId !== userId) {
    return fail("Contact introuvable", 404, "NOT_FOUND");
  }

  await prisma.contact.delete({ where: { id } });
  return ok({ message: "Contact supprimé" });
});
