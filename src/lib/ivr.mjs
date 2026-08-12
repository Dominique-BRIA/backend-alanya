// Centre d'appels (IVR) — règles communes au serveur WebSocket et à l'API HTTP.
//
// ⚠️ JavaScript et non TypeScript, pour la MÊME raison que `call-labels.mjs` :
// `ws-server.mjs` tourne dans un process Node séparé, hors de la compilation
// Next.js, et ne peut pas importer de TypeScript. Une seule implémentation pour
// les deux, sinon la règle « ce numéro est un centre » finirait par diverger
// entre le temps réel et l'API — et c'est précisément la divergence qui rendrait
// l'anonymat décoratif.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Valeur de `users.type_compte` qui marque un NUMÉRO DE CENTRE D'APPELS.
 *
 * La colonne existe depuis toujours dans le référentiel équipe : 0 = compte
 * normal, 9 = administrateur (voir `src/lib/roles.ts`). La valeur 3 était libre.
 * Aucune migration : un centre se crée en posant `type_compte = 3` sur un compte
 * ordinaire, ce qui lui laisse tout le reste — contacts, historique, fil de
 * discussion — sans le moindre cas particulier ailleurs dans le code.
 */
export const TYPE_COMPTE_CENTRE = 3;

/** Sans touche pendant ce délai, la session se referme. */
export const DELAI_MENU_MS = 60_000;

/**
 * L'agent ne décroche pas dans ce délai → retour au menu.
 *
 * Volontairement PLUS LONG que les 60 s de sonnerie d'un appel normal
 * (`_ringTimeout` côté Flutter) : si les deux étaient égaux, l'appelant
 * retournerait au menu au moment précis où l'agent verrait son écran disparaître,
 * et un décrochage de dernière seconde tomberait dans le vide.
 */
export const DELAI_SONNERIE_AGENT_MS = 95_000;

/** Ce compte est-il un numéro de centre d'appels ? */
export function estCompteCentre(user) {
  return Number(user?.typeCompte) === TYPE_COMPTE_CENTRE;
}

/**
 * Dossier des sons du standard.
 *
 * Il vit dans `public/` de Next.js, servi SANS JETON et avec le bon
 * `Content-Type` : c'est ce qui permet au lecteur média natif d'Android d'y
 * accéder, lui qui ne sait pas joindre d'en-tête `Authorization`. Aucune route
 * dédiée à écrire, donc aucune garde anti-traversée de répertoire à oublier.
 *
 * ⚠️ Résolu par `process.cwd()`, et SURTOUT PAS par
 * `new URL(..., import.meta.url)` : Turbopack résout cette forme **à la
 * compilation** et fait échouer le build de Next avec « Can't resolve
 * '../../public/ivr/' ». `tsc --noEmit` ne voit rien de tout ça — c'est bien
 * `npm run build` qui fait foi ici, pas le contrôle de types.
 *
 * Les deux process (PM2 `alanya-api` et `alanya-ws`) sont lancés depuis la
 * racine du dépôt. `IVR_SOUNDS_DIR` reste là pour un déploiement qui servirait
 * les sons depuis ailleurs.
 */
function dossierSons() {
  return process.env.IVR_SOUNDS_DIR ?? path.join(process.cwd(), "public", "ivr");
}

function urlPublique(fichier) {
  const base = (process.env.PUBLIC_BASE_URL ?? "https://alanyavox.com").replace(/\/+$/, "");
  return `${base}/ivr/${fichier}`;
}

/**
 * Rend joignable ce que la table `vocal` contient.
 *
 * 🔴 `url_vocal` N'EST PAS UNE URL, C'EST UN CHEMIN. La ligne posée par la
 * plateforme du collègue vaut `/uploads/vocaux/vocal-….wav` — un chemin relatif
 * à SON serveur, pas au nôtre : `https://alanyavox.com/uploads/vocaux/…` répond
 * 404 (vérifié le 12/08/2026). Lu tel quel, le téléphone demanderait un fichier
 * inexistant et le menu serait muet **sans la moindre erreur**, ce qui est le
 * pire des échecs : rien à voir dans les journaux, juste un silence.
 *
 * D'où `VOCAL_BASE_URL` : l'adresse de la plateforme qui héberge réellement ces
 * fichiers. Le jour où elle change, c'est une ligne de `.env` et un redémarrage,
 * pas un déploiement de code. Une valeur DÉJÀ absolue (`http…`) est respectée
 * telle quelle : la plateforme peut se mettre à écrire des URL complètes sans
 * que rien ne casse ici.
 */
export function resoudreUrlVocal(valeur, urlServeurEntreprise) {
  const brut = typeof valeur === "string" ? valeur.trim() : "";
  if (!brut) return null;
  if (/^https?:\/\//i.test(brut)) return brut;

  /*
   * L'ORDRE DES DEUX BASES N'EST PAS ARBITRAIRE.
   *
   * `company.url_serveur` d'abord : c'est la colonne que le user a demandée
   * (`docs/- Dans la table company ajouter une url_.md` — « pointer vers le
   * serveur des données de l'entreprise »), et elle existe en base. C'est la
   * seule des deux qui soit JUSTE en multi-entreprises : deux entreprises n'ont
   * aucune raison d'héberger leurs fichiers au même endroit, et une variable
   * d'environnement les forcerait à partager un serveur. Elle est vide au
   * 12/08/2026, d'où le repli.
   *
   * `VOCAL_BASE_URL` ensuite, pour faire marcher la seule entreprise existante
   * sans attendre que la colonne soit remplie.
   */
  const base =
    [urlServeurEntreprise, process.env.VOCAL_BASE_URL]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find((v) => v.length > 0) ?? "";

  /*
   * 🔴 AUCUNE DES DEUX → ON REFUSE LA LIGNE, ON NE DEVINE PAS.
   *
   * Retomber sur notre propre domaine serait le pire choix possible : il
   * fabriquerait une URL en 404 pour la ligne qui existe déjà en production, et
   * le standard passerait de « l'invite se joue » à « silence », **sans erreur
   * nulle part** — une régression provoquée par un simple oubli de `.env`, sur
   * un déploiement dont rien n'aurait signalé le problème.
   *
   * Renvoyer `null` fait retomber `urlInviteCentre` sur les fichiers, c'est-à-dire
   * sur le comportement d'avant ce lot. L'ordre entre le déploiement du code et
   * le réglage de la base cesse ainsi d'avoir la moindre importance.
   */
  if (!base) {
    console.warn(
      "[ivr] `vocal` ignorée : chemin relatif, et ni `company.url_serveur` ni VOCAL_BASE_URL",
    );
    return null;
  }
  return `${base.replace(/\/+$/, "")}/${brut.replace(/^\/+/, "")}`;
}

/**
 * Invite vocale d'un centre : « Bienvenue… tapez 1 pour… ».
 *
 * ⚠️ LA TABLE `vocal` FAIT FOI DEPUIS LE 12/08/2026, à la demande du user. Avant,
 * une convention de nommage : un centre qui déposait `public/ivr/<son Alanya
 * ID>.mp3` avait son message, les autres partageaient `accueil.mp3`. Elle
 * marchait, mais elle liait le message au NUMÉRO et exigeait un accès au
 * serveur de fichiers pour changer une invite ; la table permet à la plateforme
 * du collègue de le faire elle-même.
 *
 * **Les deux replis sont conservés, et ce n'est pas de la timidité** : la ligne
 * de production ne couvre qu'un centre sur deux, et `202020` n'a que
 * `accueil.mp3`. Retirer la convention rendrait muet un menu qui fonctionne
 * aujourd'hui.
 *
 * L'ordre est donc : la table, puis le fichier au nom du numéro, puis
 * `accueil.mp3`. Et `null` si rien n'existe — l'écran du menu doit rester
 * utilisable en silence, les options étant de toute façon affichées.
 *
 * ⚠️ Une panne de base ne doit pas emporter l'invite : la lecture est gardée,
 * et un échec retombe sur les fichiers au lieu de faire échouer l'ouverture du
 * standard.
 */
export async function urlInviteCentre(prisma, centre) {
  const url = await urlVocalEnBase(prisma, centre);
  if (url) return url;

  const dossier = dossierSons();
  const propre = centre?.publicNumber ? `${centre.publicNumber}.mp3` : null;
  if (propre && existsSync(path.join(dossier, propre))) return urlPublique(propre);
  if (existsSync(path.join(dossier, "accueil.mp3"))) return urlPublique("accueil.mp3");
  return null;
}

/**
 * La ligne `vocal` d'un centre, résolue en URL joignable.
 *
 * L'unicité de la table porte sur **(entreprise, centre)** : un même numéro peut
 * donc porter plusieurs lignes. On préfère celle de l'entreprise du centre
 * lui-même, et à défaut la plus récente — un `idVocal` plus grand désigne le
 * dernier vocal téléversé, qui est celui qu'on vient de vouloir mettre en place.
 */
async function urlVocalEnBase(prisma, centre) {
  if (!prisma?.vocal || !centre?.id) return null;
  try {
    const lignes = await prisma.vocal.findMany({
      where: { center_alanyaID: centre.id },
      orderBy: { idVocal: "desc" },
      // L'entreprise est jointe pour son `url_serveur` : c'est elle qui dit où
      // vivent SES fichiers, et la lire ici évite une seconde requête.
      select: {
        idCompany: true,
        urlVocal: true,
        company: { select: { urlServeur: true } },
      },
    });
    if (lignes.length === 0) return null;
    const sienne =
      lignes.find((l) => centre.idCompany != null && l.idCompany === centre.idCompany) ??
      lignes[0];
    return resoudreUrlVocal(sienne.urlVocal, sienne.company?.urlServeur);
  } catch (e) {
    console.error("[ivr] lecture de `vocal`:", e?.message ?? e);
    return null;
  }
}

/**
 * Musique d'attente, tirée au sort parmi `public/ivr/attente-*.mp3`.
 *
 * ⚠️ À TIRER À L'OUVERTURE DE LA SESSION, pas au moment de la touche. L'URL part
 * avec `ivr_menu` : le client a ainsi toute la durée de l'invite pour la mettre
 * en cache, et la musique démarre à l'instant de l'appui au lieu de laisser
 * trois secondes de silence.
 */
export function choisirMusiqueAttente() {
  const dossier = dossierSons();
  let fichiers = [];
  try {
    fichiers = readdirSync(dossier).filter((f) => /^attente-.*\.mp3$/i.test(f));
  } catch {
    return null;
  }
  if (fichiers.length === 0) return null;
  return urlPublique(fichiers[Math.floor(Math.random() * fichiers.length)]);
}

/**
 * Le menu d'un centre, lu dans la table `center` du référentiel équipe.
 *
 * Cette table EST la table de routage décrite par le guide, sous d'autres noms :
 * `center_alanyaID` le numéro du centre, `menuNro` la touche, `users_alanyaID`
 * l'agent, `libelle` le nom du service. Rien à créer.
 *
 * Trois points que la table permet et que le guide n'envisageait pas :
 *
 *  - **plusieurs agents sur une même touche.** Une touche est un SERVICE, pas
 *    une personne ; le référentiel prévoit d'ailleurs `maxAgentsPerCenter`. On
 *    regroupe donc par `menuNro` et on renvoie la liste des agents, à charge de
 *    l'appelant de la fonction d'en prendre un de libre.
 *
 *  - **le libellé annoncé est celui du SERVICE**, jamais le nom de l'agent.
 *    C'est ce qui rend l'anonymat gratuit : changer d'agent ne change rien à ce
 *    que l'appelant voit.
 *
 *  - **une touche ANNONCÉE mais pas encore ouverte.** Une ligne sans
 *    `users_alanyaID` décrit un service que l'invite vocale promet et qu'aucun
 *    agent ne dessert encore. Ce n'est pas la même chose qu'une touche
 *    inexistante : le vocal l'annonce, l'appelant l'a entendue, lui répondre
 *    « choix invalide » serait un mensonge. On la renvoie donc au client, marquée
 *    indisponible, et l'appui dessus a son propre message.
 *
 * Ajouter un service = une ligne en base. Aucun redéploiement.
 */
export async function lireMenuCentre(prisma, centreId) {
  const lignes = await prisma.center.findMany({
    where: {
      center_alanyaID: centreId,
      menuNro: { not: null },
    },
    orderBy: { menuNro: "asc" },
    select: { menuNro: true, libelle: true, users_alanyaID: true },
  });

  const parTouche = new Map();
  for (const l of lignes) {
    const touche = Number(l.menuNro);
    if (!Number.isFinite(touche)) continue;
    if (!parTouche.has(touche)) {
      parTouche.set(touche, { digit: touche, label: l.libelle, agentIds: [] });
    }
    if (l.users_alanyaID) parTouche.get(touche).agentIds.push(l.users_alanyaID);
  }
  return [...parTouche.values()];
}

/**
 * Ce qu'on envoie au CLIENT : la touche, son libellé, et si elle mène quelque
 * part. Rien d'autre.
 *
 * ⚠️ Jamais `agentIds`. Le client n'en a aucun besoin, et le lui transmettre
 * ruinerait l'anonymat même s'il ne l'affiche pas — un identifiant qui arrive
 * jusqu'au client est un identifiant public.
 *
 * `disponible` est dérivé, jamais stocké : un service redevient joignable dès
 * qu'on lui rattache un agent en base, sans rien à mettre à jour ailleurs.
 */
export function optionsPubliques(options) {
  return options.map(({ digit, label, agentIds }) => ({
    digit,
    label,
    disponible: agentIds.length > 0,
  }));
}

/**
 * Cet agent peut-il prendre un appel ?
 *
 * Même définition que `estOccupe` de `src/lib/calls.ts`, et pour la même raison
 * qu'il en existe une copie : `ws-server.mjs` ne peut pas importer de
 * TypeScript. La SOURCE AUTORITAIRE est la base — pas la présence d'une socket,
 * ni la colonne `center.in_call`. Un agent peut être en ligne sur un autre
 * appareil, ou son application avoir été tuée en pleine conversation.
 *
 * `leftAt: null` sans exiger `joinedAt` : un agent dont le téléphone SONNE déjà
 * pour un autre appelant est occupé, même s'il n'a pas encore décroché. Sans
 * cela, deux appelants du standard pourraient le faire sonner en même temps.
 */
export async function agentDisponible(prisma, agentId) {
  const occupe = await prisma.callParticipant.findFirst({
    where: {
      userId: agentId,
      leftAt: null,
      call: { status: { in: ["RINGING", "ONGOING"] } },
    },
    select: { callId: true },
  });
  return occupe === null;
}

/**
 * Premier agent libre d'un service, ou `null` s'ils sont tous en ligne.
 *
 * Séquentiel et non parallèle : dès qu'on en trouve un, les suivants n'ont pas
 * à être interrogés. Un service compte au plus `maxAgentsPerCenter` agents (5
 * par défaut dans le référentiel), l'ordre de la table fait donc office de
 * priorité — le premier inscrit est le premier sollicité.
 */
export async function choisirAgentLibre(prisma, agentIds) {
  for (const id of agentIds) {
    if (await agentDisponible(prisma, id)) return id;
  }
  return null;
}
