import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { ajouterClientFile } from "@/lib/queue";

/**
 * POST /api/queue/join — Entrée d'un client dans la file d'attente d'un centre.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const body = await req.json();
    const { idCompany, centerAlanyaID, idService, idAgent, priorite } = body;

    if (!idCompany || !centerAlanyaID) {
      return fail("Paramètres `idCompany` et `centerAlanyaID` requis", 400);
    }

    const res = await ajouterClientFile({
      idCompany: Number(idCompany),
      centerAlanyaID: String(centerAlanyaID),
      idCustomer: userId,
      idService: idService ? Number(idService) : null,
      idAgent: idAgent ? String(idAgent) : null,
      priorite: priorite ? Number(priorite) : 0,
    });

    return ok(res);
  } catch (e: any) {
    return fail(`Erreur lors de l'entrée en file: ${e?.message ?? e}`, 500);
  }
});
