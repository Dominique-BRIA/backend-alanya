import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// GET /api/account/privacy — réglages de confidentialité de l'utilisateur.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { readReceipts: true, lastSeenVisibility: true, chiffrementActif: true },
  });
  return ok({
    readReceipts: u?.readReceipts ?? 1,
    lastSeenVisibility: u?.lastSeenVisibility ?? 2,
    /*
     * ⚠️ LE DÉFAUT EST `true`, ICI AUSSI. Un compte introuvable ou un serveur
     * plus ancien que la colonne doit laisser le client CHIFFRER, pas se taire :
     * le réglage par défaut protège, et c'est la décision du 12/10/2026.
     */
    chiffrementActif: u?.chiffrementActif ?? true,
  });
});

// POST /api/account/privacy — met à jour un ou plusieurs réglages.
// Body { readReceipts?: 0|1, lastSeenVisibility?: 0|1|2 }.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = await req.json();
  const data: {
    readReceipts?: number;
    lastSeenVisibility?: number;
    chiffrementActif?: boolean;
  } = {};

  /*
   * ⚠️ LE COUPER N'OUVRE RIEN DE CE QUI EST DÉJÀ FERMÉ : les conversations
   * déjà chiffrées le restent — le chiffrement ne se défait pas. Ce réglage
   * arrête seulement d'en chiffrer de nouvelles, et les clients le disent.
   */
  if (typeof body?.chiffrementActif === "boolean") {
    data.chiffrementActif = body.chiffrementActif;
  }

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
    select: { readReceipts: true, lastSeenVisibility: true, chiffrementActif: true },
  });
  return ok({
    chiffrementActif: u.chiffrementActif,
    readReceipts: u.readReceipts,
    lastSeenVisibility: u.lastSeenVisibility,
  });
});
