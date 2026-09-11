import { redis, PREFIXE } from "./redis-client.mjs";

/**
 * QU'UN MESSAGE ENVOYÉ DEUX FOIS NE S'ÉCRIVE QU'UNE.
 *
 * 🔴 LE DÉFAUT QUE CE MODULE CORRIGE. Le mobile garde ses envois dans une file
 * persistée en SQLite (`lib/core/outbox.dart`) et les rejoue au retour du
 * réseau. L'entrée n'en sort qu'une fois la réponse du serveur reçue. Si la
 * coupure tombe APRÈS que le serveur a écrit le message mais AVANT que la
 * réponse n'arrive — réseau perdu, application tuée — le client croit l'envoi
 * échoué et le rejoue. Le message part alors une seconde fois, et rien côté
 * serveur ne s'y oppose : le `tempId` du client ne servait qu'à lui renvoyer
 * son écho, il n'était comparé à rien.
 *
 * Le remède tient en une clé posée avant l'écriture. Le deuxième envoi la
 * trouve, n'écrit rien, et reçoit l'identifiant du message déjà créé — donc la
 * même réponse que le premier. Le client retire son entrée de la file et
 * n'insiste plus.
 *
 * ⚠️ CE N'EST PAS DU CACHE, et c'est pourquoi ce module ne vit pas dans
 * `cache-redis.mjs`. Un cache accélère ; ceci garantit. Une entrée de cache
 * perdue coûte une lecture en base ; une réservation perdue coûte un doublon
 * visible par l'utilisateur.
 *
 * ⚠️ SANS REDIS, AUCUNE PROTECTION — comme avant ce module. La règle du dépôt
 * reste tenue : Redis absent, tout fonctionne comme auparavant. Mais la
 * conséquence est ici plus lourde qu'ailleurs, et c'est un argument pour que
 * `REDIS_URL` soit posée partout où de vrais utilisateurs écrivent.
 *
 * Écrit en `.mjs` : `ws-server.mjs` est du JavaScript exécuté sans compilation
 * et ne peut pas importer un `.ts`. Les deux chemins d'envoi — la socket et la
 * route REST — partagent donc le même module, et la même clé.
 */

/**
 * VINGT-QUATRE HEURES.
 *
 * La file du mobile abandonne au bout de cinq tentatives, mais rien ne borne le
 * temps qui les sépare : un téléphone éteint le soir rejoue le lendemain matin.
 * Une heure aurait laissé passer ce cas-là, qui est le plus courant.
 *
 * Au-delà d'un jour, le rejeu d'un message devient un message que
 * l'utilisateur a voulu envoyer deux fois — on le laisse partir.
 */
export const DUREE_RESERVATION = 24 * 60 * 60;

/**
 * Marque une réservation POSÉE dont l'écriture n'est pas finie.
 *
 * ⚠️ IL FAUT DISTINGUER « déjà écrit » de « en train de s'écrire ». Deux envois
 * simultanés du même `tempId` — deux appareils qui rejouent la même file, un
 * double appui — arrivent à quelques millisecondes d'intervalle. Le second doit
 * comprendre qu'il n'a rien à écrire, mais il ne peut pas encore recevoir
 * l'identifiant du message : il n'existe pas. Il repart alors en erreur
 * franche, et son client réessaiera — la réservation sera complète d'ici là.
 *
 * Rendre un succès vide aurait été pire : le client aurait retiré l'entrée de
 * sa file en croyant le message envoyé, alors qu'il ne l'était peut-être pas.
 */
export const EN_COURS = "*";

/** La clé d'un envoi. Portée par le COMPTE : deux comptes peuvent choisir le même tempId. */
export function cleEnvoi(userId, tempId) {
  return `${PREFIXE}envoi:${userId}:${tempId}`;
}

/**
 * Réserve un envoi, ou dit qu'il a déjà eu lieu.
 *
 * Rend `{ reserve: true }` quand la voie est libre — l'appelant écrit, puis
 * DOIT appeler `confirmerEnvoi` ou `annulerEnvoi`. Rend `{ reserve: false,
 * messageId }` quand l'envoi a déjà eu lieu ; `messageId` vaut `null` si
 * l'écriture est encore en cours (voir [EN_COURS]).
 *
 * ⚠️ TOUTE ERREUR REDIS REND `{ reserve: true }`. Redis muet ne doit pas
 * empêcher quelqu'un d'envoyer un message : on retombe alors sur le
 * comportement d'avant ce module, où le doublon était possible. Refuser
 * l'envoi échangerait un défaut rare contre une panne totale.
 */
export async function reserverEnvoi(userId, tempId) {
  const c = redis();
  if (!c || !tempId || !userId) return { reserve: true, messageId: null };

  const cle = cleEnvoi(userId, tempId);
  try {
    const pose = await c.set(cle, EN_COURS, "EX", DUREE_RESERVATION, "NX");
    if (pose === "OK") return { reserve: true, messageId: null };

    // La clé existait : quelqu'un est passé avant.
    const connu = await c.get(cle);
    return {
      reserve: false,
      messageId: connu && connu !== EN_COURS ? connu : null,
    };
  } catch {
    return { reserve: true, messageId: null };
  }
}

/**
 * Inscrit l'identifiant du message dans la réservation.
 *
 * ⚠️ LE DÉLAI EST REPOSÉ ICI, volontairement : la fenêtre de vingt-quatre
 * heures doit courir depuis le message écrit, et non depuis la réservation.
 * Sans cela, une écriture lente raccourcirait d'autant la protection.
 */
export async function confirmerEnvoi(userId, tempId, messageId) {
  const c = redis();
  if (!c || !tempId || !userId || !messageId) return;
  try {
    await c.set(cleEnvoi(userId, tempId), String(messageId), "EX", DUREE_RESERVATION);
  } catch {
    // La réservation restera sur EN_COURS et expirera seule. Le pire cas est un
    // rejeu refusé une fois, que le client retentera.
  }
}

/**
 * Efface une réservation dont l'écriture a échoué.
 *
 * 🔴 SANS CET APPEL, UN ÉCHEC DEVIENDRAIT DÉFINITIF. Le message n'a pas été
 * écrit, mais la clé resterait en place vingt-quatre heures : le rejeu — le
 * comportement même que la file du mobile est censée offrir — s'entendrait
 * répondre « déjà envoyé » pour un message qui n'existe nulle part. À appeler
 * dans chaque chemin d'erreur qui suit une réservation.
 */
export async function annulerEnvoi(userId, tempId) {
  const c = redis();
  if (!c || !tempId || !userId) return;
  try {
    await c.del(cleEnvoi(userId, tempId));
  } catch {
    // Elle expirera d'elle-même.
  }
}

/**
 * Le `tempId` tel qu'on accepte de le recevoir, ou `null`.
 *
 * ⚠️ IL VIENT DU CLIENT ET ENTRE DANS UNE CLÉ REDIS : sans borne, un client
 * bavard écrirait des clés d'un mégaoctet, et un client malveillant pourrait y
 * glisser des caractères de structure. On n'accepte que ce que les clients
 * produisent réellement — un UUID, un identifiant court — et l'on refuse le
 * reste en silence, ce qui revient à ne pas dédupliquer : le message part,
 * comme avant ce module.
 */
export function tempIdValide(brut) {
  if (typeof brut !== "string") return null;
  const net = brut.trim();
  if (net.length === 0 || net.length > 64) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(net)) return null;
  return net;
}

/* ─────────────────────────────── Contrôles hors ligne */

function autoControle() {
  let ok = 0;
  let ko = 0;
  const v = (attendu, obtenu, libelle) => {
    if (attendu === obtenu) {
      ok++;
      console.log(`ok    ${libelle}`);
    } else {
      ko++;
      console.error(`echec ${libelle} — attendu ${JSON.stringify(attendu)}, obtenu ${JSON.stringify(obtenu)}`);
    }
  };

  // --- La clé porte le compte
  v(true, cleEnvoi("u1", "t1") !== cleEnvoi("u2", "t1"),
    "deux comptes, le meme tempId : deux cles distinctes");
  v(true, cleEnvoi("u1", "t1").startsWith(PREFIXE),
    "la cle porte le prefixe du depot");
  v(true, cleEnvoi("u1", "t1") === cleEnvoi("u1", "t1"),
    "la meme paire rend toujours la meme cle");

  // --- Le tempId accepté
  v("abc", tempIdValide("abc"), "un identifiant simple passe");
  v("a-b_c.d", tempIdValide("a-b_c.d"), "les separateurs usuels passent");
  v(null, tempIdValide("a:b"), "le deux-points, separateur de nos cles, est refuse");
  v("abc", tempIdValide("  abc  "), "les espaces autour sont retires");
  v(null, tempIdValide(""), "vide refuse");
  v(null, tempIdValide("   "), "blanc refuse");
  v(null, tempIdValide(null), "null refuse");
  v(null, tempIdValide(42), "un nombre refuse");
  v(null, tempIdValide({}), "un objet refuse");
  v(null, tempIdValide("a".repeat(65)), "trop long refuse");
  v("a".repeat(64), tempIdValide("a".repeat(64)), "la borne exacte passe");
  v(null, tempIdValide("al:envoi:autre"), "un caractere de structure refuse");
  v(null, tempIdValide("a b"), "un espace interieur refuse");
  v(null, tempIdValide("a\nb"), "un retour a la ligne refuse");

  // --- Un UUID, ce que les clients produisent réellement
  v("3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    tempIdValide("3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
    "un UUID passe");

  // --- La sentinelle ne peut pas être confondue avec un identifiant
  v(null, tempIdValide(EN_COURS),
    "la sentinelle EN_COURS n'est pas un tempId acceptable");

  // --- La durée
  v(86400, DUREE_RESERVATION, "la reservation dure vingt-quatre heures");

  console.log(`\n${ok} contrôles OK, ${ko} en échec`);
  return ko === 0;
}

// Exécuté directement (`node src/lib/idempotence.mjs`) et non importé.
if (process.argv[1] && process.argv[1].endsWith("idempotence.mjs")) {
  process.exit(autoControle() ? 0 : 1);
}
