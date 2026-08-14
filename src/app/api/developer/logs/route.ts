import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { withAuth } from '@/lib/auth-context';

// GET /api/developer/logs — Télémétrie et Journal des Requêtes API Développeur
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const developer = await prisma.developerAccount.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!developer) {
      return ok({ logs: [], avgLatencyMs: 0, successRatePercent: 100 });
    }

    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') || 50), 100);

    const logs = await prisma.developerApiLog.findMany({
      where: { developerId: developer.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        endpoint: true,
        method: true,
        statusCode: true,
        latencyMs: true,
        keyPrefix: true,
        createdAt: true,
      },
    });

    // Calcul de la latence moyenne et du taux de succès
    const totalCount = logs.length;
    const avgLatencyMs = totalCount > 0
      ? Math.round(logs.reduce((acc, l) => acc + l.latencyMs, 0) / totalCount)
      : 0;

    const successCount = logs.filter((l) => l.statusCode >= 200 && l.statusCode < 300).length;
    const successRatePercent = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 100;

    return ok({
      logs,
      avgLatencyMs,
      successRatePercent,
    });
  } catch (error: any) {
    console.error('[API Developer Logs] Erreur:', error);
    return fail('Erreur de récupération des logs développeur', 500);
  }
});
