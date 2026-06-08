import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { addContactSchema } from "@/lib/validation";

// Forme renvoyée par la requête (annotation locale : structurellement compatible
// avec le type Prisma une fois le client complètement généré).
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
  const { publicNumber, alias } = addContactSchema.parse(await req.json());

  const target = await prisma.user.findUnique({ where: { publicNumber } });
  if (!target) return fail("Aucun utilisateur avec ce numéro", 404, "NOT_FOUND");
  if (target.id === userId) return fail("Vous ne pouvez pas vous ajouter vous-même", 400, "SELF");

  const existing = await prisma.contact.findUnique({
    where: { userId_contactId: { userId, contactId: target.id } },
  });
  if (existing) return fail("Ce contact existe déjà", 409, "ALREADY_CONTACT");

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
