import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

// GET /api/calls/missed?since=<ISO8601>
//
// Nombre d'appels manqués depuis une date, pour la pastille de l'onglet Appels.
//
// Pourquoi la date vient du CLIENT plutôt que d'un champ « vu » en base : marquer
// les appels comme vus supposerait une colonne de plus et une écriture à chaque
// ouverture de l'onglet. Une simple date de dernière consultation, gardée sur
// l'appareil, donne le même résultat visible sans toucher au schéma.
//
// La contrepartie est assumée : la pastille est propre à l'appareil. Consulter
// ses appels sur un téléphone ne l'efface pas sur un autre. C'est le compromis
// qui évite une migration pour un compteur d'affichage.
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const brut = req.nextUrl.searchParams.get("since");
  const since = brut ? new Date(brut) : null;
  const depuis =
    since && !Number.isNaN(since.getTime())
      ? since
      // Sans date exploitable, on regarde les dernières 24 h : un compteur
      // portant sur tout l'historique afficherait un nombre absurde au premier
      // lancement.
      : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const count = await prisma.callParticipant.count({
    where: {
      userId,
      call: {
        // Manqué = l'appel ne m'était pas destiné par moi-même, et personne n'a
        // décroché. REJECTED est volontairement exclu : refuser un appel, c'est
        // l'avoir vu.
        initiatorId: { not: userId },
        status: { in: ["MISSED", "NO_ANSWER", "BUSY"] },
        startedAt: { gt: depuis },
      },
    },
  });

  return ok({ count, since: depuis });
});
