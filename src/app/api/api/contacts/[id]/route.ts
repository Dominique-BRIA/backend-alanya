import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { updateContactSchema } from "@/lib/validation";

// PATCH /api/contacts/:id — met à jour un contact (alias, blocage).
export const PATCH = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id } = await ctx.params;
  const data = updateContactSchema.parse(await req.json());

  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact || contact.userId !== userId) {
    return fail("Contact introuvable", 404, "NOT_FOUND");
  }

  const updated = await prisma.contact.update({
    where: { id },
    data: {
      alias: data.alias ?? undefined,
      isBlocked: data.isBlocked ?? undefined,
    },
  });
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
