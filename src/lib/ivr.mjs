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

// Même règle d'affichage que partout ailleurs (pseudo, puis nom, puis numéro) :
// le repli de libellé d'une touche de centre vocal est le NOM DU CENTRE, il doit
// donc être écrit exactement comme le client l'affiche par ailleurs.
import { nomAffichage } from "./display-name.mjs";

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

/**
 * Valeur de `users.type_compte` qui marque un CENTRE VOCAL.
 *
 * Un centre vocal est un centre d'appels dont les touches ne mènent à personne :
 * chacune joue un SON au lieu de faire sonner un agent. Tout le reste est
 * commun — l'invite d'accueil, le pavé, le minuteur, l'écran.
 *
 * 🔴 CETTE VALEUR ÉTAIT DÉJÀ ÉCRITE PAR `POST /api/auth/register-dev`, qui
 * marquait ainsi les comptes développeurs. Le user a tranché le 18/08/2026 : 4
 * désigne un centre vocal, la route développeur cesse d'y toucher (lot C). Le
 * statut développeur était de toute façon porté par `developer_accounts` et
 * `developer_api_keys` — aucun contrôle d'accès ne lisait `typeCompte`. Vérifié
 * en production avant de trancher : les 3 comptes développeurs existants sont
 * en `type_compte` 0, 0 et 2, aucun n'était à 4. Rien à migrer.
 */
export const TYPE_COMPTE_CENTRE_VOCAL = 4;

/** Sans touche pendant ce délai, la session se referme. */
export const DELAI_MENU_MS = 60_000;

/**
 * Plafond de sécurité sur la lecture d'un son de centre vocal.
 *
 * ⚠️ IL EN FAUT UN, et c'est une conséquence directe du choix « le son tourne en
 * boucle » (user, 18/08/2026) : une boucle ne se termine jamais, donc aucun
 * événement naturel ne referme la session. Sans ce plafond, un téléphone au fond
 * d'une poche garderait un appel `RINGING` indéfiniment — et l'appelant
 * resterait « occupé » pour tous ceux qui essaieraient de le joindre, puisque
 * `estOccupe` se calcule sur les lignes `callParticipant` de cet appel.
 *
 * Volontairement TRÈS long : ce n'est pas un minuteur d'inactivité (l'appelant
 * écoute, il n'est pas inactif), c'est un filet. Le minuteur de 60 s du menu,
 * lui, reste suspendu pendant toute la lecture.
 */
export const DELAI_LECTURE_MAX_MS = 30 * 60_000;

/**
 * L'agent ne décroche pas dans ce délai → retour au menu.
 *
 * Volontairement PLUS LONG que les 60 s de sonnerie d'un appel normal
 * (`_ringTimeout` côté Flutter) : si les deux étaient égaux, l'appelant
 * retournerait au menu au moment précis où l'agent verrait son écran disparaître,
 * et un décrochage de dernière seconde tomberait dans le vide.
 */
export const DELAI_SONNERIE_AGENT_MS = 95_000;

/**
 * Durée maximale d'attente dans la file avant retour au menu.
 *
 * Configurable via `IVR_QUEUE_TIMEOUT_MINUTES` (entier, minutes) dans `.env` —
 * défaut **5 minutes** si absente, non numérique, ou ≤ 0 (une valeur pareille
 * viderait la file en boucle, ce n'est jamais l'intention). ⚠️ Lue une seule
 * fois à l'import de ce module, comme toute variable d'environnement : un
 * changement de valeur exige un redémarrage de `alanya-ws` (`pm2 restart
 * alanya-ws`), pas seulement une modification du `.env`.
 */
function dureeAttenteMaxMs() {
  const minutes = Number(process.env.IVR_QUEUE_TIMEOUT_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60_000;
  return 300_000; // 5 minutes
}
export const DELAI_ATTENTE_MAX_MS = dureeAttenteMaxMs();

/** Ce compte est-il un numéro de centre d'appels ? */
export function estCompteCentre(user) {
  return Number(user?.typeCompte) === TYPE_COMPTE_CENTRE;
}

/** Ce compte est-il un numéro de centre VOCAL ? */
export function estCentreVocal(user) {
  return Number(user?.typeCompte) === TYPE_COMPTE_CENTRE_VOCAL;
}

/**
 * Ce compte ouvre-t-il un standard, de l'une ou l'autre sorte ?
 *
 * Existe pour que l'aiguillage de `handleCallRing` pose UNE question et non
 * deux : les deux sortes partagent la garde de ré-entrée, le refus des appels
 * de groupe et le fait que personne ne sonne. Seul ce qu'on ouvre ensuite
 * diffère.
 */
export function ouvreUnStandard(user) {
  return estCompteCentre(user) || estCentreVocal(user);
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
 * Le bip qui annonce à l'appelant qu'il peut commencer à dicter sa plainte,
 * sur la touche 0 d'un centre vocal.
 *
 * 🔴 UNE VARIABLE D'ENVIRONNEMENT, ET PAS UNE COLONNE — décision du user
 * (19/08/2026). La collègue téléverse le fichier sur SON serveur et en donne le
 * lien ; nous le rangeons dans `BIP_ENREGISTREMENT_URL`. Une colonne
 * `company.url_bip_enregistrement` avait été posée puis retirée : ne pas la
 * réintroduire. Le son est le MÊME pour toute la plateforme — c'est exactement
 * la demande « indépendant d'un centre vocal à un autre » — et une variable
 * évite une troisième colonne à nous dans une table du référentiel équipe.
 * Même mécanique que `VOCAL_BASE_URL`, née du même besoin.
 *
 * ⚠️ L'URL DOIT ÊTRE ABSOLUE. Contrairement à `url_vocal` et `url_music`, elle
 * ne se résout contre aucun `company.url_serveur` : il n'y a pas d'entreprise
 * dans cette lecture, c'est tout l'intérêt. Un chemin relatif est donc REFUSÉ
 * ici plutôt que concaténé à `alanyavox.com`, où il répondrait 404 et
 * produirait un silence sans erreur — le pire des échecs, déjà vécu le 12/08.
 *
 * ⚠️ NON RENSEIGNÉE, ON REND `null` ET C'EST VOLONTAIRE : l'enregistrement
 * démarre alors sans annonce, plutôt que de ne pas démarrer du tout. Une
 * variable oubliée ne doit jamais rendre la fonction inutilisable.
 */
export function urlBipEnregistrement() {
  const brut = (process.env.BIP_ENREGISTREMENT_URL ?? "").trim();
  if (!brut) return null;
  if (!/^https?:\/\//i.test(brut)) {
    console.warn(
      "[ivr] BIP_ENREGISTREMENT_URL ignoree : une URL ABSOLUE est attendue, recu",
      brut,
    );
    return null;
  }
  return brut;
}

/**
 * Rend joignable un chemin déposé par la plateforme — vocal comme musique.
 *
 * 🔴 `url_vocal` ET `url_music` NE SONT PAS DES URL, CE SONT DES CHEMINS. Les
 * lignes posées par la plateforme valent `/uploads/vocaux/…` ou
 * `/uploads/musiques/…` — relatifs à SON serveur, pas au nôtre :
 * `https://alanyavox.com/uploads/…` répond 404 (vérifié le 12/08/2026). Lus tels
 * quels, le téléphone demanderait un fichier inexistant et le standard serait
 * muet **sans la moindre erreur**, ce qui est le pire des échecs : rien à voir
 * dans les journaux, juste un silence.
 *
 * D'où `VOCAL_BASE_URL` : l'adresse de la plateforme qui héberge réellement ces
 * fichiers. Le jour où elle change, c'est une ligne de `.env` et un redémarrage,
 * pas un déploiement de code. Une valeur DÉJÀ absolue (`http…`) est respectée
 * telle quelle : la plateforme peut se mettre à écrire des URL complètes sans
 * que rien ne casse ici.
 *
 * ⚠️ Le nom de la variable parle de vocal parce qu'elle est née avec lui ; elle
 * désigne en réalité LE SERVEUR de la plateforme, musiques comprises. La
 * renommer coûterait une modification de `.env` sur une production qui tourne,
 * pour un gain nul.
 */
export function resoudreUrlPlateforme(valeur, urlServeurEntreprise) {
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
   *
   * 🔴 CES DEUX-LÀ ET RIEN D'AUTRE (corrigé le 18/08/2026). La liste se
   * terminait par `PUBLIC_BASE_URL` puis le littéral `"https://alanyavox.com"`,
   * si bien que `base` n'était JAMAIS vide : le refus documenté juste en
   * dessous était du code mort, et le cas « aucune base connue » produisait
   * exactement l'URL en 404 que ce commentaire décrit comme le pire choix
   * possible. Vérifié en exécutant la fonction sans les deux variables : elle
   * rendait `https://alanyavox.com/uploads/…` au lieu de `null`.
   *
   * Ces deux replis-là étaient faux par nature, et pas seulement mal placés :
   * ils désignent NOTRE domaine, alors qu'on cherche l'adresse du serveur de la
   * PLATEFORME. Un chemin `/uploads/…` n'a jamais eu de sens chez nous.
   *
   * ⚠️ Sans effet sur la production actuelle, où `VOCAL_BASE_URL` est
   * renseignée : seul le chemin dégradé change, et il passe d'un silence
   * inexplicable à un repli sur les fichiers du dépôt.
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
      "[ivr] ligne plateforme ignorée : chemin relatif, et ni `company.url_serveur` ni VOCAL_BASE_URL",
    );
    return null;
  }
  return `${base.replace(/\/+$/, "")}/${brut.replace(/^\/+/, "")}`;
}

/**
 * La ressource d'un centre déposée par la plateforme, résolue en URL joignable.
 *
 * ⚠️ FACTORISÉ PARCE QUE `vocal` ET `center_music` SONT DES JUMELLES : mêmes
 * colonnes, même unicité **(entreprise, centre)**, même serveur d'origine. Deux
 * lectures écrites séparément auraient fini par diverger sur le point délicat —
 * lequel de plusieurs enregistrements retenir — et la divergence ne se serait
 * signalée que par une musique jouée pour la mauvaise entreprise.
 *
 * L'unicité portant sur le COUPLE, un même numéro peut porter plusieurs lignes.
 * On préfère celle de l'entreprise du centre, et à défaut la plus récente : un
 * identifiant plus grand désigne le dernier fichier téléversé, c'est-à-dire
 * celui qu'on vient de vouloir mettre en place.
 *
 * Une panne de base ne doit jamais empêcher le standard d'ouvrir : l'échec est
 * journalisé puis traité comme une absence, et l'appelant retombe sur les
 * fichiers du dépôt.
 */
async function urlRessourceDeCentre(prisma, centre, { table, cleId, champUrl }) {
  const delegue = prisma?.[table];
  if (!delegue || !centre?.id) return null;
  try {
    const lignes = await delegue.findMany({
      where: { center_alanyaID: centre.id },
      orderBy: { [cleId]: "desc" },
      // L'entreprise est jointe pour son `url_serveur` : c'est elle qui dit où
      // vivent SES fichiers, et la lire ici évite une seconde requête.
      select: {
        idCompany: true,
        [champUrl]: true,
        company: { select: { urlServeur: true } },
      },
    });
    if (lignes.length === 0) return null;
    const sienne =
      lignes.find(
        (l) => centre.idCompany != null && l.idCompany === centre.idCompany,
      ) ?? lignes[0];
    return resoudreUrlPlateforme(sienne[champUrl], sienne.company?.urlServeur);
  } catch (e) {
    console.error(`[ivr] lecture de \`${table}\`:`, e?.message ?? e);
    return null;
  }
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
  const url = await urlRessourceDeCentre(prisma, centre, {
    table: "vocal",
    cleId: "idVocal",
    champUrl: "urlVocal",
  });
  if (url) return url;

  const dossier = dossierSons();
  const propre = centre?.publicNumber ? `${centre.publicNumber}.mp3` : null;
  if (propre && existsSync(path.join(dossier, propre))) return urlPublique(propre);
  if (existsSync(path.join(dossier, "accueil.mp3"))) return urlPublique("accueil.mp3");
  return null;
}

/**
 * Musique d'attente d'un centre, jouée pendant qu'on cherche un agent.
 *
 * ⚠️ LA TABLE `center_music` FAIT FOI DEPUIS LE 12/08/2026 (créée par la
 * collègue). Elle **change la règle**, et pas seulement l'endroit où l'on
 * range les fichiers : le dossier tirait AU SORT parmi plusieurs titres, la
 * table donne UN titre PAR CENTRE. Deux appelants d'un même standard entendent
 * donc désormais la même chose, et deux standards peuvent avoir chacun leur
 * ambiance — ce que le tirage rendait impossible.
 *
 * Le dossier `attente-*.mp3` reste en repli, pour un centre sans ligne. Le
 * retirer rendrait le silence à tous ceux que la collègue n'a pas encore
 * configurés.
 *
 * ⚠️ À CHOISIR À L'OUVERTURE DE LA SESSION, pas au moment de la touche. L'URL
 * part avec `ivr_menu` : le client a ainsi toute la durée de l'invite pour la
 * mettre en cache, et la musique démarre à l'instant de l'appui au lieu de
 * laisser trois secondes de silence.
 */
export async function choisirMusiqueAttente(prisma, centre) {
  const enBase = await urlRessourceDeCentre(prisma, centre, {
    table: "centerMusic",
    cleId: "idMusic",
    champUrl: "urlMusic",
  });
  if (enBase) return enBase;

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
 * Musiques d'attente de la file d'attente d'un centre (`vocal_attente`),
 * jouées en boucle lorsque tous les agents sont occupés.
 *
 * Contient une série de musiques classées par ordre d'écoute (`ordre` ASC).
 * Si la table est vide, retombe sur les musiques d'attente locales ou [choisirMusiqueAttente].
 */
export async function urlsVocalAttente(prisma, centre) {
  if (!centre?.id && !centre?.idCompany) return [];

  try {
    let lignes = [];

    // 1. Essai via Prisma Client (colonnes réelles : idVocalAttente, url_vocal, titre, ordre)
    if (prisma?.vocalAttente) {
      lignes = await prisma.vocalAttente.findMany({
        where: {
          OR: [
            ...(centre.id ? [{ center_alanyaID: centre.id }] : []),
            ...(centre.idCompany != null ? [{ idCompany: centre.idCompany }] : []),
          ],
        },
        orderBy: [{ ordre: "asc" }, { idVocalAttente: "asc" }],
        select: {
          idCompany: true,
          center_alanyaID: true,
          urlVocal: true,
          titre: true,
          company: { select: { urlServeur: true } },
        },
      });
    }

    // 2. Fallback SQL brut si Prisma n'a pas le delegate ou ne renvoie rien
    if ((!lignes || lignes.length === 0) && prisma?.$queryRawUnsafe) {
      const cid = centre.id ?? "";
      const compId = centre.idCompany ?? -1;
      lignes = await prisma.$queryRawUnsafe(`
        SELECT va.url_vocal AS "urlVocal", va."idCompany", va."center_alanyaID",
               va.titre, c.url_serveur AS "urlServeur"
        FROM vocal_attente va
        LEFT JOIN company c ON c.idcompany = va."idCompany"
        WHERE va."center_alanyaID"::text = '${cid}'
           OR va."idCompany" = ${compId}
        ORDER BY va.ordre ASC, va."idVocalAttente" ASC
      `);
    }

    if (lignes && lignes.length > 0) {
      // Filtrer par centre.id d'abord, sinon idCompany
      let filtre = lignes.filter(
        (l) => centre.id && l.center_alanyaID === centre.id
      );
      if (filtre.length === 0 && centre.idCompany != null) {
        filtre = lignes.filter((l) => l.idCompany === centre.idCompany);
      }
      if (filtre.length === 0) filtre = lignes;

      const urls = filtre
        .map((l) => {
          const urlBase = l.company?.urlServeur ?? l.urlServeur;
          return resoudreUrlPlateforme(l.urlVocal, urlBase);
        })
        .filter(Boolean);

      if (urls.length > 0) {
        console.log(
          `[ivr] vocal_attente : ${urls.length} musique(s) pour le centre ${centre.id ?? centre.idCompany}`,
          filtre.map((l) => l.titre ?? l.urlVocal),
        );
        return urls;
      }
    }
  } catch (e) {
    console.error("[ivr] lecture de `vocal_attente`:", e?.message ?? e);
  }

  const dossier = dossierSons();
  try {
    const fichiers = readdirSync(dossier).filter((f) => /^attente-.*\.mp3$/i.test(f));
    if (fichiers.length > 0) {
      return fichiers.map((f) => urlPublique(f));
    }
  } catch {}

  const unique = await choisirMusiqueAttente(prisma, centre);
  return unique ? [unique] : [];
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
    select: {
      menuNro: true,
      libelle: true,
      nomService: true,
      users_alanyaID: true,
      idService: true,
    },
  });

  const parTouche = new Map();
  for (const l of lignes) {
    const touche = Number(l.menuNro);
    if (!Number.isFinite(touche)) continue;
    if (!parTouche.has(touche)) {
      parTouche.set(touche, {
        digit: touche,
        label: l.libelle,
        // ⚠️ NORMALISÉE À `null` DÈS LA LECTURE. La colonne est nullable, et une
        // chaîne vide n'y est pas moins probable qu'un NULL — les deux veulent
        // dire « pas de nom de service ». Trancher ici évite d'avoir à s'en
        // souvenir dans chaque client : un seul endroit décide ce que « vide »
        // signifie, et le client ne reçoit jamais qu'un texte utile ou `null`.
        nomService: nomDeService(l.nomService),
        // Lien vers le catalogue `service` (15/08/2026) : NULL tant que la
        // ligne `center` n'a pas été explicitement rattachée. Jamais deviné
        // par nom — voir la doc de la migration `2026-08_center_idservice.sql`.
        idService: null,
        agentIds: [],
      });
    }
    /*
     * Plusieurs lignes pour une même touche : la PREMIÈRE qui porte un
     * `nom_service` le donne au service. Une touche est un service, ses lignes
     * ne sont que ses agents — mais rien n'oblige la plateforme à renseigner la
     * colonne sur toutes, et prendre la première ligne aveuglément afficherait
     * un nom vide alors qu'il est écrit deux lignes plus bas. Même règle pour
     * `idService`.
     */
    const service = parTouche.get(touche);
    service.nomService ??= nomDeService(l.nomService);
    service.idService ??= l.idService ?? null;
    if (l.users_alanyaID) service.agentIds.push(l.users_alanyaID);
  }

  /**
   * TOUCHE 0 IMPLICITE — le centre agit comme son propre agent.
   *
   * Seulement si AUCUNE ligne ne référence `menuNro = 0` : une ligne déjà
   * posée par la plateforme (même sans `users_alanyaID`, c'est-à-dire un
   * service annoncé mais pas encore staffé) reste prioritaire — la boucle
   * ci-dessus l'a déjà mise dans `parTouche`, ce bloc ne s'exécute pas pour
   * elle. C'est la même règle que pour les autres touches, appliquée à 0.
   *
   * `agentIds: [centreId]` : c'est ELLE qui fait tenir toute la fonctionnalité.
   * Le compte connecté avec les identifiants du centre devient un agent comme
   * un autre pour cette touche — sonné, mis en file, noté — sans qu'aucune
   * ligne `center` n'ait besoin d'exister. Voir `choisirAgentIvrLibre` dans
   * ws-server.mjs pour la raison pour laquelle `agentDisponible` seul ne peut
   * PAS déterminer si CE candidat-là est libre.
   */
  if (!parTouche.has(0)) {
    parTouche.set(0, {
      digit: 0,
      label: "Opérateur",
      nomService: null,
      idService: null,
      agentIds: [centreId],
    });
  }

  // Triée par touche : l'ajout de la 0 se fait APRÈS la boucle (donc en
  // dernier dans la Map), et `optionsPubliques` doit rendre un ordre stable
  // pour tout client qui l'affiche en liste plutôt qu'en pavé.
  return [...parTouche.values()].sort((a, b) => a.digit - b.digit);
}

/** Un nom de service utilisable, ou `null` — jamais une chaîne vide. */
function nomDeService(valeur) {
  const propre = typeof valeur === "string" ? valeur.trim() : "";
  return propre.length > 0 ? propre : null;
}

/**
 * Le menu d'un CENTRE VOCAL, lu dans `center_audio`.
 *
 * Pendant de [lireMenuCentre], et volontairement écrit en miroir : même forme
 * d'option en sortie, pour que tout ce qui vient après — `optionsPubliques`, le
 * message `ivr_menu`, l'écran du client — ne sache pas de quelle sorte de
 * standard il s'agit. La seule différence est ce vers quoi la touche pointe :
 * `agentIds` pour un centre d'appels, `audioUrl` pour un centre vocal.
 *
 * ⚠️ AUCUNE TOUCHE 0 IMPLICITE ici, contrairement à [lireMenuCentre]. Là-bas,
 * la touche 0 fait du centre son propre agent — un secours qui n'a de sens que
 * s'il y a quelqu'un derrière. Un centre vocal n'a personne : fabriquer une
 * touche 0 qui ne joue rien annoncerait une option muette. Le `0` de la
 * production (« Information sur les produits ») est une VRAIE ligne
 * `center_audio`, lue comme les autres.
 *
 * ⚠️ `url_audio` est un CHEMIN relatif au serveur de la plateforme, jamais une
 * URL : on passe donc par `resoudreUrlPlateforme`, exactement comme l'invite
 * d'accueil. Une ligne qu'on ne sait pas résoudre (ni `company.url_serveur` ni
 * `VOCAL_BASE_URL`) donne `audioUrl: null` — la touche existe, s'affiche, et
 * revient marquée indisponible. C'est la même honnêteté que « service annoncé
 * mais pas encore desservi » du centre d'appels : mentir en répondant « choix
 * invalide » à une touche que l'accueil vient d'annoncer serait pire.
 *
 * L'unicité `(center_alanyaID, menunro)` étant posée en base, une touche porte
 * au plus une ligne : aucun départage à écrire, contrairement à `vocal`.
 *
 * Une panne de base ne doit jamais empêcher le standard d'ouvrir : l'échec est
 * journalisé et traité comme un menu vide, que l'appelant du dessus refuse
 * proprement.
 */
export async function lireMenuVocal(prisma, centre) {
  if (!prisma?.centerAudio || !centre?.id) return [];

  let lignes = [];
  try {
    lignes = await prisma.centerAudio.findMany({
      where: { center_alanyaID: centre.id },
      orderBy: { menuNro: "asc" },
      select: {
        menuNro: true,
        titre: true,
        urlAudio: true,
        // L'entreprise est jointe pour son `url_serveur` : c'est elle qui dit
        // où vivent SES fichiers. Même lecture que `urlRessourceDeCentre`.
        company: { select: { urlServeur: true } },
      },
    });
  } catch (e) {
    console.error("[ivr] lecture de `center_audio`:", e?.message ?? e);
    return [];
  }

  /*
   * LE REPLI DE LIBELLÉ EST LE NOM DU CENTRE VOCAL (user, 18/08/2026).
   *
   * `titre` est nullable, et vide sur 3 des 4 lignes de production. Le client
   * affiche `nomService ?? label` sur le pavé : en mettant le titre dans
   * `nomService` et le nom du centre dans `label`, la règle demandée tombe
   * toute seule, SANS UNE LIGNE DE CODE CLIENT — c'est exactement la mécanique
   * du centre d'appels, où `center.libelle` sert de repli à `center.nom_service`.
   */
  const repli = nomDeService(nomAffichage(centre)) ?? centre.publicNumber ?? "Menu";

  const options = [];
  for (const l of lignes) {
    const touche = Number(l.menuNro);
    if (!Number.isFinite(touche)) continue;
    options.push({
      digit: touche,
      label: repli,
      nomService: nomDeService(l.titre),
      audioUrl: resoudreUrlPlateforme(l.urlAudio, l.company?.urlServeur),
      // Vide et jamais rempli : un centre vocal ne fait sonner personne. Le
      // champ existe pour que l'option ait la MÊME FORME que celle d'un centre
      // d'appels, ce dont dépend `optionsPubliques`.
      agentIds: [],
    });
  }
  return options.sort((a, b) => a.digit - b.digit);
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
 *
 * ⚠️ `audioUrl` non plus n'est pas envoyé, et ce n'est pas un oubli : le son
 * d'un centre vocal part avec `ivr_play`, à l'appui, et pas avec le menu. Le
 * serveur reste ainsi le seul à décider ce qui se joue et quand — c'est lui qui
 * tient l'état de la session, donc le minuteur du menu et le plafond de lecture.
 * Envoyer la table des sons d'avance laisserait le client jouer sans que le
 * serveur le sache, et les deux ne seraient plus d'accord sur l'étape en cours.
 */
export function optionsPubliques(options) {
  return options.map(({ digit, label, nomService, agentIds, audioUrl }) => ({
    digit,
    label,
    /*
     * `nomService` est ENVOYÉ À CÔTÉ de `label`, et ne le remplace pas.
     *
     * Le client n'en fait pas le même usage aux deux endroits — sur le pavé, il
     * affiche le nom du service et retombe sur `label` s'il n'y en a pas ; sous
     * le nom du centre, il n'affiche RIEN plutôt que `label`. Un serveur qui
     * aurait fondu les deux en un seul champ aurait rendu la seconde règle
     * impossible à écrire : « vide » ne se distinguerait plus de « replié ».
     */
    nomService: nomService ?? null,
    /*
     * « CETTE TOUCHE MÈNE-T-ELLE QUELQUE PART ? » — une seule question, deux
     * sortes de réponse.
     *
     * Un centre d'appels mène à un AGENT, un centre vocal à un SON. Écrire deux
     * fonctions aurait dupliqué tout le reste de la sérialisation pour cette
     * seule ligne, et les deux auraient fini par diverger sur ce que le client
     * reçoit — c'est-à-dire sur le seul point qui compte ici.
     *
     * `audioUrl` est nul quand le chemin de la plateforme n'a pas pu être
     * résolu ; `agentIds` est vide quand aucun agent ne dessert le service. Les
     * deux veulent dire la même chose à l'appelant : la touche est annoncée,
     * elle s'affiche, mais elle est grisée et l'appui a son propre message.
     */
    disponible: audioUrl != null || agentIds.length > 0,
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
