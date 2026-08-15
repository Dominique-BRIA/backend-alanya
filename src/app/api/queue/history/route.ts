import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/queue/history — récupère l'historique et les métriques de la file d'attente.
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);

    const logs = await prisma.queueFileHistorique.findMany({
      take: limit,
      orderBy: { joinedAt: "desc" },
      include: {
        company: { select: { nomCompany: true } },
        service: { select: { libelle: true } },
        agent: { select: { pseudo: true, publicNumber: true } },
        customer: { select: { pseudo: true, publicNumber: true } },
      },
    });

    const totalCalls = logs.length;
    const misEnRelationCount = logs.filter((l) => l.statut === "MIS_EN_RELATION").length;
    const abandonCount = logs.filter((l) => l.statut === "ABANDON").length;
    const timeoutCount = logs.filter((l) => l.statut === "TIMEOUT").length;

    const ratedLogs = logs.filter((l) => l.note !== null);
    const avgNote = ratedLogs.length > 0
      ? ratedLogs.reduce((acc, curr) => acc + (curr.note ?? 0), 0) / ratedLogs.length
      : null;

    const formattedLogs = logs.map((l) => ({
      idHist: l.idHist.toString(),
      idCompany: l.idCompany,
      companyName: l.company?.nomCompany ?? null,
      centerId: l.center_alanyaID,
      serviceId: l.idService,
      serviceName: l.service?.libelle ?? null,
      agentId: l.idAgent,
      agentName: l.agent?.pseudo ?? l.agent?.publicNumber ?? null,
      customerId: l.idCustomer,
      customerName: l.customer?.pseudo ?? l.customer?.publicNumber ?? null,
      statut: l.statut,
      joinedAt: l.joinedAt.toISOString(),
      leftAt: l.leftAt?.toISOString() ?? null,
      attenteDureeSec: l.attenteDureeSec,
      appelDureeSec: l.appelDureeSec,
      note: l.note,
      avisCommentaire: l.avisCommentaire,
    }));

    return ok({
      stats: {
        totalCalls,
        misEnRelationCount,
        abandonCount,
        timeoutCount,
        averageRating: avgNote ? Number(avgNote.toFixed(2)) : null,
      },
      history: formattedLogs,
    });
  } catch (e: any) {
    return fail(`Erreur lors de la récupération de l'historique: ${e?.message ?? e}`, 500);
  }
});
