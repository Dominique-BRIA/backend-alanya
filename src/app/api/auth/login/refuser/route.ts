import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { refuserDefi } from "@/lib/deux-etapes";

// POST /api/auth/login/refuser — « Ce n'est pas moi », depuis l'application :
// le code envoyé ne servira plus. Body { defiId }.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const body = await req.json().catch(() => null);
  const defiId = typeof body?.defiId === "string" ? body.defiId : "";
  if (!defiId) return fail("Défi manquant", 400, "VALIDATION");
  const refuse = await refuserDefi(userId, defiId);
  return ok({ refuse });
});
