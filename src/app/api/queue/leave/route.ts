import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { abandonnerFile } from "@/lib/queue";

/**
 * POST /api/queue/leave — Enregistre le départ/abandon d'un client en attente.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const body = await req.json();
    const { centerAlanyaID } = body;

    if (!centerAlanyaID) {
      return fail("Paramètre `centerAlanyaID` requis", 400);
    }

    const res = await abandonnerFile(String(centerAlanyaID), userId);

    if (!res) {
      return ok({ message: "Le client n'était pas présent dans la file d'attente", abandon: null });
    }

    return ok({ abandon: res });
  } catch (e: any) {
    return fail(`Erreur lors de l'abandon de file: ${e?.message ?? e}`, 500);
  }
});
