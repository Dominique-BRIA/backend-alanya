import { redis, PREFIXE } from "./redis-client.mjs";

/**
 * LE CACHE DE LECTURE — première brique de l'intégration Redis.
 *
 * 🔴 CE MODULE NE STOCKE QUE DES COPIES. Aucune donnée n'existe ici sans exister
 * aussi dans PostgreSQL. C'est ce qui rend ce lot réversible : effacer tout
 * Redis ne perdrait rien, et retirer `REDIS_URL` du `.env` ramène exactement le
 * comportement d'avant son installation.
 *
 * L'écriture des MESSAGES ne passe pas par ici et n'y passera pas sans une
 * décision explicite : y mettre des messages non encore persistés changerait
 * radicalement le risque, et ce n'est pas ce qui a été validé.
 *
 * POURQUOI CE LOT D'ABORD. L'envoi d'un message fait aujourd'hui QUATORZE
 * allers-retours en base avant que le message parte aux destinataires, dont
 * NEUF sont des lectures — la conversation, ses membres, le profil de
 * l'expéditeur, les métadonnées d'un média. Ces neuf-là se répètent à chaque
 * message d'une même conversation et ne changent presque jamais. Les mettre en
 * cache retire l'essentiel de la latence sans jamais risquer un message.
 */

/* ─────────────────────────────── Les clés */

/**
 * LA CONVENTION DE NOMMAGE, tenue en un seul endroit.
 *
 * `al:` + type + identifiant + facette. Le préfixe isole notre espace, le type
 * permet de balayer une famille, la facette évite de tout recharger quand une
 * seule partie change — renommer un groupe ne doit pas invalider la liste de
 * ses membres.
 *
 * ⚠️ Ne JAMAIS composer une clé à la main ailleurs dans le code. Une clé écrite
 * en double finit toujours par diverger d'un caractère, et l'on obtient alors
 * deux caches du même objet qui se contredisent — défaut invisible à la lecture
 * du code, et très coûteux à diagnostiquer.
 */
export const cles = {
  convMeta: (convId) => `${PREFIXE}conv:${convId}:meta`,
  convMembres: (convId) => `${PREFIXE}conv:${convId}:membres`,
  profil: (userId) => `${PREFIXE}user:${userId}:profil`,
};

/** Durées de vie, en secondes. */
export const DUREES = {
  /*
   * Cinq minutes pour une conversation : son type et son caractère de groupe ne
   * changent jamais, mais sa liste de membres, si. L'invalidation explicite
   * couvre les changements que NOUS faisons ; ce délai couvre ceux qu'on
   * n'aurait pas prévus — un membre retiré par une autre plateforme, par
   * exemple. Un cache sans expiration finit toujours par mentir.
   */
  conversation: 300,
  /*
   * ⚠️ UNE MINUTE SEULEMENT POUR LA LISTE DES MEMBRES, et c'est délibérément
   * bien plus court que tout le reste.
   *
   * 🔴 Cette liste N'EST PAS UNE DONNÉE D'AFFICHAGE : c'est le CONTRÔLE D'ACCÈS.
   * C'est elle qui décide qui peut écrire dans une conversation et qui en reçoit
   * les messages. Une copie périmée d'un nom affiche un nom périmé ; une copie
   * périmée de cette liste-ci laisse quelqu'un qu'on vient d'exclure continuer à
   * lire et à écrire.
   *
   * L'effacement explicite couvre les quatre écritures qui changent la
   * composition d'une conversation — ajout, retrait, départ volontaire,
   * suppression — et c'est lui qui fait le travail : en marche normale,
   * l'exclusion prend effet IMMÉDIATEMENT. Cette minute ne borne que le cas où
   * l'effacement lui-même aurait échoué, Redis ayant hoqueté au mauvais instant.
   * C'est le prix à payer, et il se paie en secondes plutôt qu'en minutes.
   */
  membres: 60,
  // Un profil bouge encore moins : nom, avatar, numéro.
  profil: 600,
};

/* ─────────────────────────────── Lecture */

/**
 * Lit une valeur du cache, ou la charge et la range.
 *
 * ⚠️ TOUTE ERREUR REDIS EST AVALÉE, et c'est le cœur de la conception : une
 * panne de cache ne doit produire aucune erreur visible. On appelle alors le
 * chargeur, exactement comme si le cache était vide.
 *
 * ⚠️ `null` EST UNE VALEUR LÉGITIME et il est mis en cache lui aussi. Sans cela,
 * une conversation supprimée serait redemandée à la base à chaque message —
 * c'est précisément le cas où le cache sert le plus, puisque la réponse ne
 * changera plus.
 */
export async function lireOuCharger(cle, dureeSecondes, chargeur) {
  const c = redis();

  if (c) {
    try {
      const brut = await c.get(cle);
      if (brut !== null) return JSON.parse(brut);
    } catch {
      // Redis muet, lent ou illisible : on descend à la base, sans bruit.
    }
  }

  const valeur = await chargeur();

  if (c) {
    try {
      // `JSON.stringify(undefined)` rend `undefined`, que Redis refuse : on
      // normalise en `null`, seule forme que la relecture saura interpréter.
      await c.set(cle, JSON.stringify(valeur ?? null), "EX", dureeSecondes);
    } catch {
      // Cache plein (`noeviction`) ou coupé : la valeur est déjà calculée, on
      // la rend. Ne pas avoir pu la ranger n'est pas un échec de la requête.
    }
  }

  return valeur;
}

/* ─────────────────────────────── Invalidation */

/**
 * Efface des clés. À appeler dès qu'une écriture rend le cache faux.
 *
 * ⚠️ INVALIDER PLUTÔT QUE METTRE À JOUR. Réécrire la valeur exacte semble plus
 * malin, mais suppose que l'appelant connaisse la forme complète de l'objet
 * caché. Il suffit d'un champ oublié pour que le cache contienne un objet
 * incomplet, que plus rien ne corrigera avant l'expiration. Effacer est bête et
 * toujours juste : la prochaine lecture rechargera tout depuis la base.
 */
export async function invalider(...clesAEffacer) {
  const c = redis();
  if (!c || clesAEffacer.length === 0) return;
  try {
    await c.del(...clesAEffacer);
  } catch {
    // L'invalidation a échoué : la valeur périmée vivra jusqu'à son expiration.
    // C'est pourquoi AUCUNE durée de vie n'est infinie dans `DUREES`.
  }
}

/* ─────────────────────────────── Observabilité */

/**
 * L'état du cache, pour un point de santé.
 *
 * ⚠️ `used_memory` FACE À `maxmemory` est la mesure qui compte. Avec
 * `noeviction`, atteindre le plafond ne supprime RIEN : Redis refuse les
 * écritures. Le cache cesse alors de se remplir — l'application continue de
 * fonctionner, en base directe — mais il faut le savoir AVANT que cela arrive,
 * pas en lisant les journaux après coup.
 */
export async function etatCache() {
  const c = redis();
  if (!c) return { actif: false, raison: "REDIS_URL absente" };

  /*
   * 🔴 CE POINT-CI ATTEND LA CONNEXION. Lui seul.
   *
   * `redis()` n'ouvre la connexion qu'au PREMIER appel, et ioredis refuse toute
   * commande tant que sa poignée de main n'est pas finie
   * (`enableOfflineQueue: false`). Le tout premier appel à ce point de santé
   * après un redémarrage est donc aussi celui qui ouvre la connexion : il
   * repartait avec « Stream isn't writeable » et annonçait le cache MORT alors
   * qu'il allait très bien une demi-seconde plus tard. Constaté en production
   * le 08/09/2026, juste après la mise en service.
   *
   * ⚠️ NE JAMAIS FAIRE CETTE ATTENTE DANS `lireOuCharger`. Là, elle ajouterait
   * jusqu'à deux secondes à une requête d'utilisateur pour lui servir ce que la
   * base rendait déjà en quelques millisecondes — le contraire exact du but.
   * Une lecture qui rate le cache descend en base, sans attendre personne.
   */
  if (c.status !== "ready") {
    const pret = await new Promise((res) => {
      const fin = (v) => {
        clearTimeout(minuteur);
        c.removeListener("ready", surPret);
        res(v);
      };
      const surPret = () => fin(true);
      const minuteur = setTimeout(() => fin(false), 2000);
      c.once("ready", surPret);
    });
    if (!pret) {
      // `status` dit CE QUI se passe, là où le message d'erreur d'une commande
      // ne disait que sa conséquence : « connecting » (le serveur ne répond
      // pas), « reconnecting » (mot de passe refusé, sans doute), « end ».
      return { actif: false, raison: `connexion ${c.status}` };
    }
  }

  try {
    const info = await c.info("memory");
    const lire = (champ) => {
      const m = info.match(new RegExp(`^${champ}:(\\d+)`, "m"));
      return m ? Number(m[1]) : null;
    };
    const utilisee = lire("used_memory");
    const plafond = lire("maxmemory");

    return {
      actif: true,
      etat: c.status,
      memoireUtilisee: utilisee,
      memoirePlafond: plafond,
      // Sans plafond configuré, il n'y a pas de pourcentage à calculer — et
      // c'est en soi une anomalie à signaler.
      pourcentage:
        plafond && plafond > 0 && utilisee !== null
          ? Math.round((utilisee / plafond) * 100)
          : null,
    };
  } catch (e) {
    return { actif: false, raison: e?.message ?? "info memory a echoue" };
  }
}

/* ─────────────────────────────── Les accès mis en cache */

/**
 * ⚠️ `prisma` EST PASSÉ EN PARAMÈTRE, jamais importé ici.
 *
 * Les deux processus ont leur propre client : `ws-server.mjs` construit le sien
 * (`new PrismaClient()`), l'API Next.js utilise le singleton de `lib/prisma.ts`.
 * Importer l'un ou l'autre dans ce module partagé créerait un TROISIÈME pool de
 * connexions PostgreSQL, ouvert pour rien et compté dans la limite du serveur.
 */

/**
 * Ce qu'il faut savoir d'une conversation pour traiter un envoi.
 *
 * ⚠️ UNE SEULE LECTURE POUR TOUT. `handleSend` interrogeait la même
 * conversation TROIS FOIS — une pour la durée d'expiration, deux pour
 * `isGroup`, ces deux dernières demandant exactement la même chose à quelques
 * lignes d'écart. Trois allers-retours pour deux champs qui ne changent
 * jamais pendant un envoi.
 */
export async function metaConversation(prisma, convId) {
  return lireOuCharger(cles.convMeta(convId), DUREES.conversation, async () => {
    const c = await prisma.conversation.findUnique({
      where: { id: convId },
      select: { isGroup: true, disappearingSeconds: true },
    });
    // On range `null` aussi : une conversation supprimée ne réapparaîtra pas,
    // et redemander la base à chaque message serait le pire des cas.
    return c ? { isGroup: c.isGroup, disappearingSeconds: c.disappearingSeconds } : null;
  });
}

/**
 * Qui participe à une conversation.
 *
 * ⚠️ LA LECTURE LA PLUS FRÉQUENTE DE TOUT LE SERVEUR TEMPS RÉEL : chaque
 * message, chaque « est en train d'écrire », chaque accusé de lecture et chaque
 * changement de présence la refait. Vingt-trois appels dans `ws-server.mjs`.
 *
 * ⚠️ NE JAMAIS Y METTRE AUTRE CHOSE QUE LES IDENTIFIANTS. La ligne complète d'un
 * participant porte `unreadCount`, `lastReadAt`, `sourdine`, `role` — des champs
 * qui changent à chaque message et à chaque lecture. Les mettre en cache
 * afficherait des compteurs de non-lus faux, et il faudrait alors invalider à
 * chaque message : le cache coûterait plus qu'il ne rapporte. La composition,
 * elle, ne change que quatre fois dans toute la vie du code.
 */
export async function membresConversation(prisma, convId) {
  const liste = await lireOuCharger(cles.convMembres(convId), DUREES.membres, async () => {
    const lignes = await prisma.participant.findMany({
      where: { convId },
      select: { userId: true },
    });
    return lignes.map((l) => l.userId);
  });

  /*
   * ⚠️ EN CAS DE DOUTE, PERSONNE N'EST MEMBRE — jamais l'inverse.
   *
   * Si une valeur illisible traînait sous cette clé (format d'une version
   * précédente, écriture tronquée), `includes` lèverait sur une valeur non
   * tableau et ferait échouer l'envoi. Rendre une liste VIDE refuse l'accès :
   * l'utilisateur voit une erreur, ce qui se corrige. L'inverse — accorder par
   * défaut — ouvrirait la conversation à qui n'y est pas.
   */
  return Array.isArray(liste) ? liste : [];
}

/**
 * Le profil d'affichage d'un compte : ce que la notification et l'écho
 * réclament à chaque message.
 */
export async function profilCache(prisma, userId) {
  return lireOuCharger(cles.profil(userId), DUREES.profil, async () => {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { nom: true, pseudo: true, publicNumber: true, avatarUrl: true },
    });
    return u ?? null;
  });
}

/**
 * 🔴 POURQUOI LES MÉDIAS NE SONT PAS MIS EN CACHE, alors qu'ils en avaient
 * l'air le meilleur candidat — un binaire téléversé ne change jamais.
 *
 * Les deux endroits qui les lisent s'y prêtent mal, chacun pour sa raison :
 *
 * - À L'ENVOI (`ws-server.mjs`), chaque identifiant de média est lu UNE SEULE
 *   FOIS, dans les secondes qui suivent son téléversement. Le cache n'y serait
 *   jamais touché deux fois : que du rangement, aucune économie. Pire, il y
 *   serait DANGEREUX — un média supprimé entre-temps serait déclaré existant,
 *   et le message créé pointerait vers une ligne absente, ce que PostgreSQL
 *   refuserait par clé étrangère. Un envoi qui échoue est bien plus grave que
 *   quelques millisecondes gagnées.
 *
 * - AU TÉLÉCHARGEMENT (`GET /api/media/:id`), la lecture est bien répétée, mais
 *   ce qu'elle rapporte n'est pas le média : c'est le DROIT d'y accéder, calculé
 *   sur les participants de la conversation. Or cette liste change. Mettre la
 *   décision en cache, c'est laisser quelqu'un qui vient d'être exclu d'un
 *   groupe continuer d'ouvrir ses photos jusqu'à expiration. Une fuite d'accès
 *   ne se rattrape pas.
 *
 * À reprendre le jour où l'on cachera l'appartenance elle-même, avec
 * invalidation à chaque changement de membre — pas avant.
 */

/**
 * À appeler dès qu'une conversation change de membres, de nom, ou de réglage
 * de messages éphémères.
 */
export async function invaliderConversation(convId) {
  await invalider(cles.convMeta(convId), cles.convMembres(convId));
}

/** À appeler quand un compte change de nom, de pseudo ou de photo. */
export async function invaliderProfil(userId) {
  await invalider(cles.profil(userId));
}
