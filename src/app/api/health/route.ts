import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { etatCache } from "@/lib/cache-redis.mjs";

/**
 * GET /api/health — l'état des deux dépendances du backend.
 *
 * 🔴 SANS CE POINT, LA SATURATION DU CACHE EST INVISIBLE. Redis est configuré en
 * `noeviction` : arrivé à son plafond de deux gigaoctets, il ne supprime RIEN,
 * il REFUSE les écritures. L'application continue de fonctionner — chaque
 * lecture redescend en base — mais le cache cesse silencieusement de servir à
 * quoi que ce soit. Rien dans l'interface ne le montrerait, et l'on croirait le
 * cache actif des mois durant.
 *
 * ⚠️ AUCUNE AUTHENTIFICATION, et donc aucune donnée sensible : ni version, ni
 * nom d'hôte, ni chaîne de connexion. Un point de santé sert justement quand
 * l'authentification est ce qui ne marche plus ; l'exiger le rendrait muet au
 * moment où on en a besoin. En échange, il ne dit que « ça répond » ou « ça ne
 * répond pas », plus un pourcentage de remplissage.
 *
 * `pourcentage` est ce qu'il faut surveiller : au-delà de 85, il est temps de
 * relever `maxmemory` ou de raccourcir les durées de vie.
 */
export async function GET() {
  let base = "ko";
  try {
    // La requête la moins chère qui prouve vraiment que la connexion vit : un
    // `findFirst` ferait un plan de requête et lirait une table.
    await prisma.$queryRaw`SELECT 1`;
    base = "ok";
  } catch {
    // On garde « ko » : la panne EST la réponse, elle ne doit pas lever.
  }

  const cache = await etatCache();

  return NextResponse.json(
    {
      ok: base === "ok",
      base,
      cache: {
        actif: cache.actif,
        etat: cache.actif ? cache.etat : (cache.raison ?? null),
        pourcentage: cache.actif ? cache.pourcentage : null,
      },
    },
    {
      // Un état mis en cache par un intermédiaire ne vaut rien : c'est
      // l'instant présent qu'on interroge.
      status: base === "ok" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
