import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { z } from "zod";

const matchSchema = z.object({
  numbers: z
    .array(z.string().trim().regex(/^\d{6}$/, "Numéro invalide"))
    .min(1)
    .max(500),
});

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/**
 * POST /api/users/match
 * Body: { numbers: ["123456", "789012", ...] }
 * Reçoit les numéros extraits du répertoire téléphonique,
 * renvoie ceux qui sont sur Alanya (hors soi-même, hors déjà contacts).
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Corps de requête JSON invalide", 400, "BAD_JSON");
  }

  const parsed = matchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("Données invalides : " + parsed.error.errors[0]?.message, 422, "VALIDATION");
  }

  const { numbers } = parsed.data;
  const unique = [...new Set(numbers)];

  const found = await prisma.user.findMany({
    where: {
      publicNumber: { in: unique },
      id: { not: userId },
      emailVerified: true,
      passwordHash: { not: null },
    },
    select: {
      id: true,
      publicNumber: true,
      profile: { select: { displayName: true, avatarUrl: true, statusMsg: true } },
    },
  });

  if (found.length === 0) return ok({ matched: [] });

  const foundIds = found.map((u) => u.id);
  const alreadyContacts = await prisma.contact.findMany({
    where: { userId, contactId: { in: foundIds } },
    select: { contactId: true },
  });
  const alreadySet = new Set(alreadyContacts.map((c) => c.contactId));

  return ok({
    matched: found.map((u) => ({
      id: u.id,
      publicNumber: u.publicNumber,
      pseudo: u.profile?.displayName ?? null,
      avatarUrl: u.profile?.avatarUrl ?? null,
      statusMsg: u.profile?.statusMsg ?? null,
      alreadyContact: alreadySet.has(u.id),
    })),
  });
});
