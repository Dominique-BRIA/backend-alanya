#!/usr/bin/env node
/**
 * HARNAIS DE DIFF DE CONTRAT — Next (:3000) contre Nest (:3002)
 *
 * Rejoue le même jeu de requêtes contre les deux serveurs et compare leurs
 * réponses. C'est le filet de sécurité de toute la migration : sans lui, on
 * valide à l'œil et on laisse passer les divergences silencieuses (un 201
 * devenu 200, une clé disparue, une date sérialisée autrement).
 *
 * Usage :
 *   node tools/diff-contrat/index.mjs
 *   node tools/diff-contrat/index.mjs --verbeux     détail des écarts
 *   node tools/diff-contrat/index.mjs --tout        compare AUSSI les routes
 *                                                   pas encore migrées
 *
 * Sortie : 0 si aucun écart, 1 sinon — utilisable comme garde avant bascule.
 *
 * Prérequis : les deux serveurs tournent ET pointent sur LA MÊME base.
 * Sinon les écarts constatés viennent des données, pas du code.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import { PrismaClient } from "@prisma/client";
import { PREFIXES_MIGRES, REQUETES, resoudre } from "./catalogue.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const RACINE = join(ICI, "..", "..", "..");

const NEXT = process.env.URL_NEXT ?? "http://localhost:3000";
const NEST = process.env.URL_NEST ?? "http://localhost:3002";

const verbeux = process.argv.includes("--verbeux");
const tout = process.argv.includes("--tout");

/* ─────────────────────────── Normalisation ─────────────────────────── */

/**
 * En-têtes retenus pour la comparaison.
 *
 * Tout le reste est écarté : `date` change à chaque requête, `x-powered-by`
 * trahit le serveur, `content-length` se déduit du corps déjà comparé, et
 * `etag`/`connection` relèvent du transport. Les garder produirait un écart
 * sur chaque ligne sans jamais désigner un vrai défaut.
 */
const ENTETES_COMPARES = [
  "content-type",
  "location",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-max-age",
];

function normaliserEntetes(headers) {
  const sortie = {};
  for (const nom of ENTETES_COMPARES) {
    // `headers.get` est insensible à la casse : la différence de graphie entre
    // undici (minuscules) et Express est donc absorbée ici.
    const valeur = headers.get(nom);
    if (valeur !== null) sortie[nom] = valeur;
  }
  return sortie;
}

/** Trie les clés en profondeur : l'ordre des clés JSON n'est pas du contrat. */
function trierProfond(valeur) {
  if (Array.isArray(valeur)) return valeur.map(trierProfond);
  if (valeur && typeof valeur === "object") {
    return Object.fromEntries(
      Object.keys(valeur)
        .sort()
        .map((cle) => [cle, trierProfond(valeur[cle])]),
    );
  }
  return valeur;
}

/**
 * Remplace chaque valeur terminale par son TYPE, en gardant l'arborescence.
 *
 * C'est la comparaison « forme », utilisée pour les mutations : deux appels
 * créent deux lignes différentes, donc les valeurs divergent légitimement,
 * mais la structure et les types doivent être identiques.
 *
 * Le type est plus fin que `typeof` là où ça compte : une date doit rester une
 * CHAÎNE ISO. Si un intercepteur de sérialisation la transformait en objet, ou
 * un BigInt en nombre, la forme changerait et l'écart serait signalé — c'est
 * précisément ce qu'on cherche à attraper.
 */
function formeDe(valeur) {
  if (valeur === null) return "null";
  if (Array.isArray(valeur)) {
    // Le premier élément suffit à décrire la forme ; comparer la longueur
    // ferait échouer toute liste alimentée par une mutation.
    return valeur.length === 0 ? "[]" : [formeDe(valeur[0])];
  }
  if (typeof valeur === "object") {
    return Object.fromEntries(
      Object.keys(valeur)
        .sort()
        .map((cle) => [cle, formeDe(valeur[cle])]),
    );
  }
  if (typeof valeur === "string") {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(valeur) ? "date-iso" : "string";
  }
  return typeof valeur;
}

/* ───────────────────────────── Exécution ───────────────────────────── */

/**
 * Charge le .env de la RACINE dans process.env.
 *
 * Nécessaire avant d'instancier PrismaClient, qui lit DATABASE_URL au moment
 * de sa construction. Node ne charge pas les .env tout seul ici : le harnais
 * est lancé en script simple, sans le `--env-file` du serveur WebSocket ni le
 * chargement implicite de Next.
 *
 * Les variables déjà définies ne sont PAS écrasées : cela permet de viser une
 * autre base ou d'autres URL le temps d'une exécution.
 */
function chargerEnv() {
  const contenu = readFileSync(join(RACINE, ".env"), "utf8");
  for (const ligne of contenu.split(/\r?\n/)) {
    const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const cle = m[1];
    const valeur = m[2].trim().replace(/^"(.*)"$/, "$1");
    if (process.env[cle] === undefined) process.env[cle] = valeur;
  }
}

function lireSecret() {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET introuvable dans le .env de la racine");
  return secret;
}

/**
 * Fabrique le jeton directement, plutôt que d'appeler /api/auth/login.
 *
 * Passer par la route de connexion ferait dépendre TOUT le harnais d'une route
 * qui sera elle-même migrée en dernier, et exigerait de connaître un mot de
 * passe en clair. Signer avec le secret partagé donne le même résultat, sans
 * effet de bord ni dépendance.
 */
function fabriquerJeton(secret, userId) {
  return jwt.sign({ sub: userId, scope: "access" }, secret, { expiresIn: "1h" });
}

async function appeler(base, requete, jetonValide) {
  const options = { method: requete.methode, headers: {} };

  if (requete.jeton === "invalide") {
    options.headers.authorization = "Bearer jeton.manifestement.invalide";
  } else if (requete.auth) {
    options.headers.authorization = `Bearer ${jetonValide}`;
  }

  if (requete.corps !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(requete.corps);
  }

  const debut = Date.now();
  const reponse = await fetch(base + requete.chemin, options);
  const brut = await reponse.text();

  let corps;
  try {
    corps = brut === "" ? null : JSON.parse(brut);
  } catch {
    // Réponse non-JSON (page d'erreur HTML, binaire) : on garde le brut tronqué.
    corps = { "//brut": brut.slice(0, 200) };
  }

  return {
    statut: reponse.status,
    entetes: normaliserEntetes(reponse.headers),
    corps,
    ms: Date.now() - debut,
  };
}

function comparer(a, b, mode) {
  const ecarts = [];

  if (a.statut !== b.statut) {
    ecarts.push(`statut : Next=${a.statut}  Nest=${b.statut}`);
  }

  for (const cle of ENTETES_COMPARES) {
    if (a.entetes[cle] !== b.entetes[cle]) {
      ecarts.push(`en-tête ${cle} : Next=${a.entetes[cle] ?? "(absent)"}  Nest=${b.entetes[cle] ?? "(absent)"}`);
    }
  }

  const gauche = mode === "forme" ? formeDe(a.corps) : trierProfond(a.corps);
  const droite = mode === "forme" ? formeDe(b.corps) : trierProfond(b.corps);
  const jg = JSON.stringify(gauche);
  const jd = JSON.stringify(droite);
  if (jg !== jd) {
    ecarts.push(mode === "forme" ? "forme du corps" : "corps");
    if (verbeux) {
      ecarts.push(`    Next : ${jg.slice(0, 600)}`);
      ecarts.push(`    Nest : ${jd.slice(0, 600)}`);
    }
  }

  return ecarts;
}

function estMigree(chemin) {
  return PREFIXES_MIGRES.some((p) => chemin === p || chemin.startsWith(p + "/") || chemin.startsWith(p + "?"));
}

async function main() {
  // Avant toute chose : PrismaClient lit DATABASE_URL à sa construction.
  chargerEnv();

  const prisma = new PrismaClient();
  let contexte;
  try {
    contexte = await resoudre(prisma);
  } finally {
    await prisma.$disconnect();
  }

  const secret = lireSecret();
  const jeton = fabriquerJeton(secret, contexte.userId);

  console.log(`\n  Next : ${NEXT}`);
  console.log(`  Nest : ${NEST}`);
  console.log(`  Compte de test : ${contexte.userId}`);
  console.log(`  Préfixes migrés : ${PREFIXES_MIGRES.length ? PREFIXES_MIGRES.join(", ") : "(aucun)"}\n`);

  let identiques = 0;
  let ecartsTotal = 0;
  let enAttente = 0;
  let ignorees = 0;

  for (const brute of REQUETES) {
    // Résolution des jetons {{...}} du chemin.
    let chemin = brute.chemin;
    let manquant = null;
    for (const [cle, valeur] of Object.entries(contexte)) {
      if (chemin.includes(`{{${cle}}}`)) {
        if (valeur == null) manquant = cle;
        else chemin = chemin.replaceAll(`{{${cle}}}`, valeur);
      }
    }
    if (brute.requiert && contexte[brute.requiert] == null) manquant = brute.requiert;

    if (manquant) {
      console.log(`  ⊘  ${brute.nom}\n       ignorée : « ${manquant} » introuvable dans la base locale`);
      ignorees++;
      continue;
    }

    const requete = { ...brute, chemin };
    const mode = requete.mode ?? (requete.methode === "GET" ? "strict" : "forme");

    if (!tout && !estMigree(chemin)) {
      if (verbeux) console.log(`  ⋯  ${requete.nom}  (pas encore migrée)`);
      enAttente++;
      continue;
    }

    let a;
    let b;
    try {
      [a, b] = await Promise.all([
        appeler(NEXT, requete, jeton),
        appeler(NEST, requete, jeton),
      ]);
    } catch (e) {
      console.log(`  ✖  ${requete.nom}\n       injoignable : ${e.message}`);
      ecartsTotal++;
      continue;
    }

    const ecarts = comparer(a, b, mode);
    if (ecarts.length === 0) {
      console.log(`  ✔  ${requete.nom}  [${mode}]  ${a.statut}`);
      identiques++;
    } else {
      console.log(`  ✖  ${requete.nom}  [${mode}]`);
      for (const e of ecarts) console.log(`       ${e}`);
      ecartsTotal++;
    }
  }

  console.log(`\n  ${identiques} identique(s) · ${ecartsTotal} écart(s) · ${enAttente} en attente · ${ignorees} ignorée(s)\n`);

  if (ecartsTotal > 0) {
    console.log("  ⚠️  Écarts détectés : NE PAS basculer nginx sur ces routes.\n");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("\n  Échec du harnais :", e.message, "\n");
  process.exit(1);
});
