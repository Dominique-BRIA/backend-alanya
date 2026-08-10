import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { publicNumberSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";

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
  // Le message vient du schéma : c'est lui qui porte les bornes, et un message
  // écrit en dur ici a déjà menti pendant des mois (« 6 chiffres exactement »
  // alors que 8 était accepté).
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Numéro invalide", 422, "BAD_NUMBER");
  }

  const number = parsed.data;
  const found = await prisma.user.findUnique({
    where: { publicNumber: number },
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
    pseudo: nomAffichage(found),
    avatarUrl: avatarPublicUrl(found.avatarUrl ?? null),
    statusMsg: found.statusMsg ?? null,
    alreadyContact: Boolean(existing),
  });
});
