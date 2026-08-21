import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { withAuth } from '@/lib/auth-context';
import { CODE } from '@/lib/developer/api-contract';

/**
 * GET /api/developer/logs — journal des requêtes et télémétrie.
 *
 * 🔴 CONTRAT GELÉ le 18/08/2026 : cette route est consommée par le tableau de
 * bord d'une équipe extérieure, qui construit dessus une table paginée et des
 * indicateurs. Les noms de champs et la forme de la réponse ne changent plus.
 *
 * Paramètres :
 *   `limit`  1–100, défaut 50.
 *   `cursor` identifiant du dernier log reçu ; renvoie ceux d'AVANT.
 *   `depuis` / `jusqua` bornes ISO-8601 sur `createdAt`.
 *
 * ⚠️ DEUX DÉFAUTS CORRIGÉS ICI, et le second est le plus insidieux.
 *
 * 1. Il n'y avait ni curseur ni filtre de date, seulement `limit` plafonné à
 *    100 : au-delà des 100 derniers appels, le journal était inatteignable.
 *
 * 2. `avgLatencyMs` et `successRatePercent` étaient calculés **sur la page
 *    renvoyée**. Le tableau de bord affichait donc « latence moyenne » en
 *    montrant la moyenne des 50 dernières requêtes, et cette valeur CHANGEAIT
 *    quand on tournait la page — un indicateur qui ment sans jamais le dire.
 *    Ils sont désormais agrégés par la base sur TOUTE la période demandée,
 *    indépendamment de la pagination.
 */
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    const developer = await prisma.developerAccount.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!developer) {
      // Un compte sans profil développeur n'est pas une erreur : la console
      // s'affiche vide. `total` et `nextCursor` sont présents quand même —
      // le client ne doit jamais avoir à distinguer deux formes de réponse.
      return ok({
        logs: [],
        nextCursor: null,
        total: 0,
        avgLatencyMs: 0,
        successRatePercent: 100,
      });
    }

    const params = req.nextUrl.searchParams;
    const limitBrut = Number(params.get('limit'));
    const limit = Math.min(
      Math.max(Number.isFinite(limitBrut) && limitBrut > 0 ? limitBrut : 50, 1),
      100,
    );

    // Une borne illisible est IGNORÉE plutôt que rejetée : un filtre de date
    // mal formé ne doit pas vider l'écran de la console sans explication.
    const dateOuNull = (valeur: string | null) => {
      if (!valeur) return null;
      const d = new Date(valeur);
      return Number.isNaN(d.getTime()) ? null : d;
    };
    const depuis = dateOuNull(params.get('depuis'));
    const jusqua = dateOuNull(params.get('jusqua'));

    const filtre = {
      developerId: developer.id,
      ...(depuis || jusqua
        ? {
            createdAt: {
              ...(depuis ? { gte: depuis } : {}),
              ...(jusqua ? { lte: jusqua } : {}),
            },
          }
        : {}),
    };

    const cursor = params.get('cursor');

    const logs = await prisma.developerApiLog.findMany({
      where: filtre,
      orderBy: { createdAt: 'desc' },
      // Un de plus que demandé : c'est ce qui permet de dire s'il reste une
      // page SANS compter la table entière à chaque appel.
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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

    const encore = logs.length > limit;
    const page = encore ? logs.slice(0, limit) : logs;

    /*
     * Les indicateurs portent sur la PÉRIODE, jamais sur la page.
     *
     * `aggregate` fait le calcul dans PostgreSQL : la moyenne reste juste même
     * quand la période compte des milliers d'appels que la page ne montre pas,
     * et elle ne bouge plus quand l'utilisateur tourne les pages.
     */
    const [global, succes] = await Promise.all([
      prisma.developerApiLog.aggregate({
        where: filtre,
        _avg: { latencyMs: true },
        _count: { _all: true },
      }),
      prisma.developerApiLog.count({
        where: { ...filtre, statusCode: { gte: 200, lt: 300 } },
      }),
    ]);

    const total = global._count._all;

    return ok({
      logs: page,
      // Passer cette valeur en `cursor` au prochain appel. `null` = fin.
      nextCursor: encore ? page[page.length - 1]?.id ?? null : null,
      total,
      avgLatencyMs: Math.round(global._avg.latencyMs ?? 0),
      // 100 % quand il n'y a aucun appel : afficher 0 % ferait croire à une
      // panne alors qu'il ne s'est simplement rien passé.
      successRatePercent: total > 0 ? Math.round((succes / total) * 100) : 100,
    });
  } catch (error: any) {
    console.error('[API Developer Logs] Erreur:', error);
    return fail('Erreur de récupération des logs développeur', 500, CODE.ERREUR_INTERNE);
  }
});
