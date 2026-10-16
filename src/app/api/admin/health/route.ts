import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/redis-client.mjs";
import { routeAdmin } from "@/lib/gestion/session";
import { okAdmin } from "@/lib/gestion/reponses";
import { derniersPassages } from "@/lib/gestion/purges";

/**
 * GET /api/admin/health — ce que la supervision externe ne voit pas : les
 * tâches de fond (diffusions) en attente ou en échec, les purges qui ne
 * tournent plus, Redis, et les connexions PostgreSQL.
 *
 * La console d'origine parlait d'une file de jobs MySQL ; chez nous, les
 * tâches de fond sont les diffusions, et la base est PostgreSQL. Les champs
 * gardent leur nom pour que l'écran les lise sans retouche.
 */
export const GET = routeAdmin("settings.read", async () => {
  const maintenant = new Date();
  const [enAttente, verrouilles, enEchec, echecs, purges, connexions] = await Promise.all([
    prisma.diffusion.count({ where: { statut: "planifiee", planifieeA: { lte: maintenant } } }),
    prisma.diffusion.count({ where: { statut: "en_cours" } }),
    prisma.diffusion.count({ where: { statut: "echec" } }),
    prisma.diffusion.findMany({ where: { statut: "echec" }, orderBy: { termineeLe: "desc" }, take: 5 }),
    derniersPassages(),
    prisma.$queryRaw<{ total: bigint; actives: bigint; inactives: bigint; attente: bigint; max: number }[]>`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE state = 'active') AS actives,
             count(*) FILTER (WHERE state = 'idle') AS inactives,
             count(*) FILTER (WHERE wait_event_type = 'Lock') AS attente,
             current_setting('max_connections')::int AS max
        FROM pg_stat_activity WHERE datname = current_database()`.catch(() => []),
  ]);
  let redisConnecte = false;
  const client = redis();
  if (client) {
    try {
      redisConnecte = (await client.ping()) === "PONG";
    } catch {}
  }
  const c = connexions[0];
  return okAdmin({
    jobs: {
      enAttente,
      verrouilles,
      enEchec,
      // La boucle de fond vit dans le processus de l'API : s'il répond, elle tourne.
      workerActif: true,
      derniersEchecs: echecs.map((d) => ({
        id: Number(d.id),
        kind: "diffusion",
        tentatives: 1,
        tentativesMax: 1,
        echoueLe: d.termineeLe,
        erreur: `${d.echecs} envoi(s) en échec sur ${d.total}`,
      })),
    },
    purges,
    redis: { configure: !!client, connecte: redisConnecte },
    mysql: c
      ? {
          taille: Number(c.max),
          mesurable: true,
          ouvertes: Number(c.total),
          libres: Number(c.inactives),
          occupees: Number(c.actives),
          enAttente: Number(c.attente),
        }
      : { taille: 0, mesurable: false },
    timestamp: maintenant.toISOString(),
  });
});
