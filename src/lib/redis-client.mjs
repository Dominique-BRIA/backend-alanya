import Redis from "ioredis";

/**
 * LA CONNEXION REDIS, PARTAGÉE PAR LES DEUX PROCESSUS.
 *
 * ⚠️ Écrit en `.mjs` et non en TypeScript, et c'est OBLIGATOIRE : `ws-server.mjs`
 * est du JavaScript pur exécuté par Node sans compilation. Il ne peut pas
 * importer un `.ts`. Huit modules du dépôt suivent déjà cette règle —
 * `message-payload.mjs`, `statut-audience.mjs` — précisément pour que l'API et
 * le serveur temps réel partagent une seule vérité.
 *
 * Un module `.ts` aurait obligé à écrire le cache DEUX FOIS, et deux copies
 * finissent toujours par diverger : c'est le défaut que ce dépôt paie
 * régulièrement.
 *
 * 🔴 REDIS N'EST JAMAIS INDISPENSABLE. Toute la conception tient dans cette
 * phrase. Si Redis est absent, injoignable, saturé ou lent, l'application
 * continue de fonctionner en interrogeant PostgreSQL — plus lentement, mais
 * exactement comme avant son installation. Aucun appelant n'a d'erreur à
 * traiter, aucun écran ne se casse.
 */

/**
 * Ce qui déclenche l'utilisation de Redis : la présence de `REDIS_URL`.
 *
 * Absente, tout ce module devient une coquille vide qui répond « rien en
 * cache ». C'est ce qui rend le déploiement réversible sans changer une ligne
 * de code : retirer la variable du `.env` suffit à revenir au comportement
 * d'avant.
 */
const URL_REDIS = process.env.REDIS_URL ?? "";

/**
 * Préfixe de toutes nos clés.
 *
 * Un environnement de test sur la même machine poserait `REDIS_PREFIXE=al:dev:`
 * et ne se mélangerait jamais à la production. Sans préfixe distinct, un
 * `conv:<id>` de test écraserait celui de production — même identifiant, même
 * base Redis.
 */
export const PREFIXE = process.env.REDIS_PREFIXE ?? "al:";

let client = null;
let panneSignalee = false;

/**
 * La connexion, ou `null` quand Redis n'est pas configuré.
 *
 * ⚠️ `lazyConnect` est VOLONTAIREMENT ABSENT : on veut que la connexion s'ouvre
 * au démarrage, pour qu'une erreur de mot de passe se voie dans les journaux
 * tout de suite — et non à la première requête d'un utilisateur réel.
 *
 * ⚠️ PENDANT LA POIGNÉE DE MAIN, TOUTE COMMANDE ÉCHOUE, et c'est normal.
 * ioredis n'accepte rien avant d'avoir dit `HELLO`, annoncé son nom et vérifié
 * par un `INFO` que le serveur n'est pas en cours de chargement ; avec
 * `enableOfflineQueue: false`, ce qui part avant repart en « Stream isn't
 * writeable ». Cela dure quelques millisecondes au démarrage du processus, les
 * lectures concernées descendent en base, et personne ne le voit. Vérifié en
 * conditions réelles le 08/09/2026 : sans attendre l'état `ready`, les trois
 * premières lectures manquaient le cache.
 */
export function redis() {
  if (!URL_REDIS) return null;
  if (client) return client;

  client = new Redis(URL_REDIS, {
    /*
     * ⚠️ TROIS TENTATIVES, PUIS ON ABANDONNE LA COMMANDE.
     *
     * Par défaut, ioredis met les commandes en FILE D'ATTENTE quand la
     * connexion est coupée, et les rejoue à la reconnexion. Pour un cache,
     * c'est exactement le mauvais comportement : une requête d'utilisateur
     * resterait bloquée à attendre un Redis mort, alors que PostgreSQL, lui,
     * répond. On préfère échouer vite et lire la base.
     */
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,

    /*
     * La reconnexion, elle, est patiente : Redis redémarre en quelques
     * secondes après une mise à jour, et se rebrancher tout seul évite un
     * redémarrage manuel du backend. Plafonné à 3 s pour ne pas marteler.
     */
    retryStrategy: (tentative) => Math.min(tentative * 200, 3000),

    // Une commande qui n'a pas répondu en 1 s ne répondra pas : la base fait
    // mieux. Ce délai borne le pire cas ajouté par le cache.
    commandTimeout: 1000,
  });

  client.on("error", (e) => {
    /*
     * UNE SEULE LIGNE DE JOURNAL PAR PANNE, et non une par commande.
     *
     * Redis injoignable produit une erreur à CHAQUE tentative : sans ce
     * garde-fou, une panne d'une minute écrirait des dizaines de milliers de
     * lignes et noierait tout le reste — y compris ce qu'on cherchera pour
     * comprendre la panne.
     */
    if (!panneSignalee) {
      panneSignalee = true;
      console.error(`[redis] injoignable, on continue sur la base : ${e?.message ?? e}`);
    }
  });

  client.on("ready", () => {
    if (panneSignalee) console.log("[redis] reconnecte");
    panneSignalee = false;
  });

  return client;
}

/** Redis est-il configuré ET actuellement joignable ? */
export function redisPret() {
  const c = redis();
  return c !== null && c.status === "ready";
}

/**
 * Ferme proprement la connexion. Appelé à l'arrêt du processus.
 *
 * `quit` et non `disconnect` : il laisse les commandes en cours se terminer au
 * lieu de couper au milieu.
 */
export async function fermerRedis() {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    // Déjà fermé, ou jamais ouvert : il n'y a rien à sauver ici.
  } finally {
    client = null;
  }
}
