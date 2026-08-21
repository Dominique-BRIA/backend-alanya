import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { depilerClientSuivant } from "@/lib/queue";

/**
 * POST /api/queue/pop — Dépile le premier client en attente (FIFO) pour un centre.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const body = await req.json();
    const { centerAlanyaID } = body;

    if (!centerAlanyaID) {
      return fail("Paramètre `centerAlanyaID` requis", 400);
    }

    const res = await depilerClientSuivant(String(centerAlanyaID), userId);

    if (!res) {
      return ok({ message: "Aucun client en attente dans la file", client: null });
    }

    return ok({ client: res });
  } catch (e: any) {
    return fail(`Erreur lors du dépilage de la file: ${e?.message ?? e}`, 500);
  }
});
