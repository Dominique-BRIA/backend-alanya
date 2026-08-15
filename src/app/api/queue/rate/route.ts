import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/queue/rate — dépose une note de 1 à 5 étoiles (et commentaire) post-appel.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const body = await req.json();
    const { idHist, note, avisCommentaire } = body;

    if (!idHist) {
      return fail("Paramètre `idHist` requis", 400, "MISSING_ID_HIST");
    }

    const noteNum = Number(note);
    if (isNaN(noteNum) || noteNum < 1 || noteNum > 5) {
      return fail("La note doit être un entier entre 1 et 5", 400, "INVALID_NOTE");
    }

    const histId = BigInt(idHist);

    const hist = await prisma.queueFileHistorique.findUnique({
      where: { idHist: histId },
    });

    if (!hist) {
      return fail("Historique de file introuvable", 404, "NOT_FOUND");
    }

    if (hist.idCustomer !== userId) {
      return fail("Accès non autorisé pour noter cet appel", 403, "FORBIDDEN");
    }

    const updated = await prisma.queueFileHistorique.update({
      where: { idHist: histId },
      data: {
        note: noteNum,
        avisCommentaire: avisCommentaire ? String(avisCommentaire).trim() : null,
      },
    });

    return ok({
      idHist: updated.idHist.toString(),
      note: updated.note,
      avisCommentaire: updated.avisCommentaire,
    });
  } catch (e: any) {
    return fail(`Erreur lors de l'enregistrement de la note: ${e?.message ?? e}`, 500);
  }
});
