import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { publicNumberSchema } from "@/lib/validation";

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// GET /api/users/search?number=123456
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const raw = req.nextUrl.searchParams.get("number") ?? "";
  const parsed = publicNumberSchema.safeParse(raw);
  if (!parsed.success) return fail("Numéro invalide (6 chiffres exactement)", 422, "BAD_NUMBER");

  const number = parsed.data;
  const found = await prisma.user.findUnique({
    where: { publicNumber: number },
    include: { profile: true },
  });

  if (!found || found.id === userId) {
    return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
  }

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
