import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// GET /api/account/privacy — réglages de confidentialité de l'utilisateur.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { readReceipts: true, lastSeenVisibility: true },
  });
  return ok({
    readReceipts: u?.readReceipts ?? 1,
    lastSeenVisibility: u?.lastSeenVisibility ?? 2,
  });
});

// POST /api/account/privacy — met à jour un ou plusieurs réglages.
// Body { readReceipts?: 0|1, lastSeenVisibility?: 0|1|2 }.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = await req.json();
  const data: { readReceipts?: number; lastSeenVisibility?: number } = {};

  if (body?.readReceipts === 0 || body?.readReceipts === 1) {
    data.readReceipts = body.readReceipts;
  }
  if ([0, 1, 2].includes(body?.lastSeenVisibility)) {
    data.lastSeenVisibility = body.lastSeenVisibility;
  }
  if (Object.keys(data).length === 0) {
    return fail("Aucun réglage valide fourni", 400, "NO_CHANGES");
  }

  const u = await prisma.user.update({
    where: { id: userId },
    data,
    select: { readReceipts: true, lastSeenVisibility: true },
  });
  return ok({
    readReceipts: u.readReceipts,
    lastSeenVisibility: u.lastSeenVisibility,
  });
});
