import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createPaysSchema } from "@/lib/validation";

// GET /api/pays — liste de tous les pays référencés.
export const GET = withAuth(async (_req: NextRequest, _userId: string) => {
  const pays = await prisma.pays.findMany({
    orderBy: { libelle: "asc" },
  });
  return ok({ pays });
});

// POST /api/pays — ajoute un pays (admin / seed).
export const POST = withAuth(async (req: NextRequest, _userId: string) => {
  const body = createPaysSchema.parse(await req.json());

  const existing = await prisma.pays.findFirst({
    where: { libelle: body.libelle },
  });
  if (existing) return fail("Ce pays existe déjà", 409, "ALREADY_EXISTS");

  const pays = await prisma.pays.create({ data: body });
  return ok(pays, 201);
});
