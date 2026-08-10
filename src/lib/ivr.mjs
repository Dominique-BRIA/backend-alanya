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
 * Invite vocale d'un centre : « Bienvenue… tapez 1 pour… ».
 *
 * Convention de nommage plutôt qu'une colonne en base — un centre qui dépose
 * `public/ivr/<son Alanya ID>.mp3` a son propre message, les autres partagent
 * `accueil.mp3`. C'est ce qui permet le multi-entreprises sans toucher au
 * schéma de l'équipe.
 *
 * Renvoie `null` si aucun fichier n'existe : l'écran du menu doit rester
 * utilisable en silence, les options étant de toute façon affichées à l'écran.
 */
export function urlInviteCentre(publicNumber) {
  const dossier = dossierSons();
  const propre = publicNumber ? `${publicNumber}.mp3` : null;
  if (propre && existsSync(path.join(dossier, propre))) return urlPublique(propre);
  if (existsSync(path.join(dossier, "accueil.mp3"))) return urlPublique("accueil.mp3");
  return null;
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
