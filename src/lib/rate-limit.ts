import { type NextRequest } from "next/server";
import { redis, PREFIXE } from "./redis-client.mjs";

/**
 * COMBIEN DE FOIS PAR MINUTE — la limitation de débit, partagée par tous les
 * processus.
 *
 * 🔴 LE DÉFAUT QUE CE MODULE CORRIGE. Les compteurs vivaient dans une `Map`,
 * donc dans UN processus. Le fichier le disait déjà — « en production
 * multi-instances, remplacer par Redis » — et la conséquence était silencieuse :
 * deux processus d'API, et « 5 tentatives de connexion par minute » en
 * autorisent dix ; trente processus, cent cinquante. Rien n'échoue, rien ne se
 * voit dans les journaux, la protection a simplement disparu.
 *
 * C'est la seule limite du dépôt dont l'absence ne produit aucun symptôme, et
 * c'est pourquoi elle se corrige AVANT d'ajouter des processus, pas après.
 *
 * ⚠️ SANS REDIS, ON RETOMBE SUR LA `Map` — et surtout PAS sur « on laisse
 * passer ». C'est l'unique endroit du dépôt où la règle habituelle (« Redis
 * absent, on continue comme avant ») demande une lecture attentive : ici,
 * « comme avant » veut dire « avec une limite par processus », ce qui est
 * dégradé mais fermé. Laisser passer aurait ouvert la porte à la force brute
 * sur tous les comptes le jour où Redis hoquette — on échangerait une panne de
 * cache contre une faille.
 */

/** Fenêtre locale, utilisée quand Redis n'est pas là. */
interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** La clé Redis d'un compteur. Préfixée comme tout le reste du dépôt. */
function cleCompteur(key: string): string {
  return `${PREFIXE}rl:${key}`;
}

/**
 * Compte une tentative et dit si elle est permise.
 *
 * ⚠️ DEVENUE `async`. Les dix-huit appels du dépôt portent désormais un `await`,
 * et c'est le vrai coût de ce changement : un `await` oublié rend une `Promise`,
 * toujours vraie, donc `resultat.allowed` vaut `undefined` — la limite
 * disparaît SANS erreur. Toute route ajoutée plus tard doit vérifier ce point.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const c = redis();
  if (c) {
    try {
      return await compteurRedis(c, key, limit, windowMs);
    } catch {
      // Redis muet : la fenêtre locale prend le relais. Dégradé, jamais ouvert.
    }
  }
  return compteurLocal(key, limit, windowMs);
}

/**
 * Le compteur partagé.
 *
 * ⚠️ `INCR` PUIS `EXPIRE`, ET L'ORDRE COMPTE. On incrémente d'abord : la clé
 * naît à 1, et c'est cette valeur qui nous dit qu'on est le premier de la
 * fenêtre — donc celui qui doit poser l'échéance. Poser l'échéance à chaque
 * passage ferait glisser la fenêtre indéfiniment : quelqu'un qui tente sans
 * relâche repousserait lui-même sa propre remise à zéro, et ne serait jamais
 * relâché. C'est une fenêtre FIXE, comme l'était la version en mémoire.
 *
 * ⚠️ LES DEUX COMMANDES PARTENT ENSEMBLE (`pipeline`), en un seul aller-retour.
 * Séparées, elles doubleraient la latence de chaque route d'authentification.
 *
 * ⚠️ SI `EXPIRE` MANQUAIT — processus tué entre les deux — la clé n'aurait
 * aucune échéance et bloquerait la personne pour toujours. D'où le garde-fou :
 * un TTL négatif (`-1`, clé sans échéance) est réparé au passage suivant.
 */
async function compteurRedis(
  c: NonNullable<ReturnType<typeof redis>>,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const cle = cleCompteur(key);
  const secondes = Math.max(1, Math.ceil(windowMs / 1000));

  const pipeline = c.pipeline();
  pipeline.incr(cle);
  pipeline.ttl(cle);
  const reponses = await pipeline.exec();
  if (!reponses) throw new Error("pipeline sans réponse");

  const compte = Number(reponses[0]?.[1] ?? 0);
  const ttl = Number(reponses[1]?.[1] ?? -1);

  // Premier de la fenêtre, ou clé restée sans échéance : on la pose.
  if (compte === 1 || ttl < 0) {
    await c.expire(cle, secondes);
  }

  if (compte > limit) {
    const reste = ttl > 0 ? ttl : secondes;
    return { allowed: false, remaining: 0, retryAfterSec: reste };
  }

  return { allowed: true, remaining: limit - compte, retryAfterSec: 0 };
}

/**
 * La fenêtre locale d'origine, conservée telle quelle.
 *
 * Elle ne sert plus que de filet quand Redis manque. Son défaut — une limite
 * par processus — est exactement ce que ce module corrige ; elle reste
 * néanmoins très supérieure à l'absence de limite.
 */
function compteurLocal(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count, retryAfterSec: 0 };
}
