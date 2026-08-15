import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { prisma } from "@/lib/prisma";
import { centresDeLAgent } from "@/lib/queue-agents";

/**
 * GET /api/queue/history — historique et métriques de la file d'attente.
 *
 * ⚠️ RÉSERVÉ AUX AGENTS (15/08/2026) : ouvert à n'importe quel compte connecté
 * jusqu'ici, sans le moindre rapport avec un centre — n'importe qui pouvait
 * lire les clients de tout le monde. Restreint désormais aux centres de
 * l'appelant (voir `centresDeLAgent`).
 *
 * `centerAlanyaID` (optionnel) : un seul centre, doit faire partie des siens.
 * `excludeServed=1` (optionnel) : ne renvoie que ce qui n'a PAS abouti à un
 * agent (ABANDON/TIMEOUT/REJETE) — c'est la vue « clients à rappeler ».
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const mesCentres = await centresDeLAgent(userId);
    if (mesCentres.length === 0) {
      return fail("Réservé aux agents d'un centre d'appels", 403, "NOT_AGENT");
    }

    const { searchParams } = new URL(req.url);
    const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);
    const centerParam = searchParams.get("centerAlanyaID");
    if (centerParam && !mesCentres.includes(centerParam)) {
      return fail("Ce centre ne fait pas partie des vôtres", 403, "FORBIDDEN_CENTER");
    }
    const centerIds = centerParam ? [centerParam] : mesCentres;
    const excludeServed = searchParams.get("excludeServed") === "1";

    const logs = await prisma.queueFileHistorique.findMany({
      where: {
        center_alanyaID: { in: centerIds },
        ...(excludeServed ? { statut: { not: "MIS_EN_RELATION" } } : {}),
      },
      take: limit,
      orderBy: { joinedAt: "desc" },
      include: {
        company: { select: { libelle: true } },
        service: { select: { libelle: true } },
        agent: { select: { pseudo: true, publicNumber: true } },
        customer: { select: { pseudo: true, publicNumber: true, avatarUrl: true } },
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
      companyName: l.company?.libelle ?? null,
      centerId: l.center_alanyaID,
      serviceId: l.idService,
      serviceName: l.service?.libelle ?? null,
      agentId: l.idAgent,
      agentName: l.agent?.pseudo ?? l.agent?.publicNumber ?? null,
      customerId: l.idCustomer,
      customerName: l.customer?.pseudo ?? l.customer?.publicNumber ?? null,
      customerAvatarUrl: l.customer?.avatarUrl ?? null,
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
