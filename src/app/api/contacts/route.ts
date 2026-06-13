import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { addContactSchema } from "@/lib/validation";

interface ContactWithUser {
  id: string;
  alias: string | null;
  isBlocked: boolean;
  contact: {
    id: string;
    publicNumber: string;
    profile: { displayName: string; avatarUrl: string | null; statusMsg: string | null } | null;
  };
}

// OPTIONS — répond aux preflight CORS (Flutter mobile + Vercel)
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// GET /api/contacts — liste le répertoire de l'utilisateur.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const contacts = await prisma.contact.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { contact: { include: { profile: true } } },
  });

  return ok({
    contacts: contacts.map((c: ContactWithUser) => ({
      id: c.id,
      alias: c.alias,
      isBlocked: c.isBlocked,
      user: {
        id: c.contact.id,
        publicNumber: c.contact.publicNumber,
        pseudo: c.contact.profile?.displayName ?? null,
        avatarUrl: c.contact.profile?.avatarUrl ?? null,
        statusMsg: c.contact.profile?.statusMsg ?? null,
      },
    })),
  });
});

// POST /api/contacts — ajoute un contact via son numéro public à 6 chiffres.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("Corps de requête JSON invalide", 400, "BAD_JSON");
  }

  const parsed = addContactSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => e.message).join(", ");
    return fail(msg || "Données invalides", 422, "VALIDATION");
  }
  const { publicNumber, alias } = parsed.data;

  const target = await prisma.user.findUnique({ where: { publicNumber } });
  if (!target) return fail("Aucun utilisateur avec ce numéro Alanya", 404, "NOT_FOUND");
  if (target.id === userId) return fail("Tu ne peux pas t'ajouter toi-même", 400, "SELF");

  const existing = await prisma.contact.findUnique({
    where: { userId_contactId: { userId, contactId: target.id } },
  });
  if (existing) return fail("Ce contact est déjà dans ton répertoire", 409, "ALREADY_CONTACT");

  const created = await prisma.contact.create({
    data: { userId, contactId: target.id, alias },
    include: { contact: { include: { profile: true } } },
  });

  return ok(
    {
      id: created.id,
      alias: created.alias,
      isBlocked: created.isBlocked,
      user: {
        id: created.contact.id,
        publicNumber: created.contact.publicNumber,
        pseudo: created.contact.profile?.displayName ?? null,
        avatarUrl: created.contact.profile?.avatarUrl ?? null,
      },
    },
    201,
  );
});
