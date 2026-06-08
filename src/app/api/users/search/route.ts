import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { publicNumberSchema } from "@/lib/validation";

// GET /api/users/search?number=123456
// Recherche un utilisateur par son numéro public à 6 chiffres (annuaire).
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const raw = req.nextUrl.searchParams.get("number") ?? "";
  const parsed = publicNumberSchema.safeParse(raw);
  if (!parsed.success) return fail("Numéro invalide (6 chiffres)", 422, "BAD_NUMBER");

  const number = parsed.data;
  const found = await prisma.user.findUnique({
    where: { publicNumber: number },
    include: { profile: true },
  });

  if (!found || found.id === userId) {
    // On ne révèle pas son propre numéro comme un "contact trouvé".
    return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
  }

  // Indique si l'utilisateur est déjà dans le répertoire de l'appelant.
  const existing = await prisma.contact.findUnique({
    where: { userId_contactId: { userId, contactId: found.id } },
    select: { id: true },
  });

  return ok({
    id: found.id,
    publicNumber: found.publicNumber,
    pseudo: found.profile?.displayName ?? null,
    avatarUrl: found.profile?.avatarUrl ?? null,
    statusMsg: found.profile?.statusMsg ?? null,
    alreadyContact: Boolean(existing),
  });
});
