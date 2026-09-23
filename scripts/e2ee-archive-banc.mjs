/**
 * L'ARCHIVE CHIFFRÉE, CONTRE LE VRAI SERVEUR.
 *
 * 🔴 CE BANC NE VÉRIFIE PAS LA CRYPTOGRAPHIE — c'est le travail de
 * `STAGE-WEB/scripts/e2ee-serrures.mjs`, qui fait tourner les vrais modules du
 * navigateur. Ici on éprouve les GARDES du serveur : celles qui empêchent de se
 * mettre dans un état dont on ne sort plus.
 *
 * Usage : node --env-file=.env scripts/e2ee-archive-banc.mjs
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const API = "http://localhost:3000";
const prisma = new PrismaClient();

let echecs = 0;

function verifie(libelle, condition, detail) {
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${libelle}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      \x1b[31m${detail}\x1b[0m`);
  }
}

function titre(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}

async function compte(marque, typeCompte = 0) {
  const email = `archive-${marque}@e2ee.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: await bcrypt.hash(motDePasse, 12), emailVerified: true, typeCompte },
    create: {
      email,
      nom: `Archive ${marque}`,
      passwordHash: await bcrypt.hash(motDePasse, 12),
      publicNumber: `AR${marque}${Math.floor(Math.random() * 100000)}`,
      emailVerified: true,
      typeCompte,
    },
  });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: email,
      password: motDePasse,
      deviceId: `archive-${marque}`,
      typeDevice: 0,
    }),
  });
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`);
  return { user, jeton: (await r.json()).accessToken };
}

function appel(jeton) {
  return async (chemin, options = {}) => {
    const r = await fetch(`${API}${chemin}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jeton}`,
        ...(options.headers ?? {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const texte = await r.text();
    let json;
    try {
      json = JSON.parse(texte);
    } catch {
      json = null;
    }
    return { statut: r.status, corps: texte, json };
  };
}

const SERRURE = (type) => ({
  type,
  sel: "c2VsLWRlLXNlaXplLW9jdGV0cw==",
  iv: "aXYtZGUtZG91emUh",
  cleEnveloppee: "Y2xlLW1haXRyZXNzZS1jaGlmZnJlZS1pY2k=",
  algo: type === "motdepasse" ? "argon2id" : "pbkdf2-sha256",
  parametres:
    type === "motdepasse"
      ? JSON.stringify({ memoireKio: 65536, passes: 3, parallelisme: 1 })
      : JSON.stringify({ iterations: 1 }),
});

async function main() {
  console.log("\n\x1b[1m════ L'ARCHIVE CHIFFRÉE — LES GARDES DU SERVEUR ════\x1b[0m");

  const a = await compte("alice");
  const agent = await compte("agent", 2);
  const api = appel(a.jeton);
  const apiAgent = appel(agent.jeton);

  // On repart propre.
  await prisma.e2eeArchiveBloc.deleteMany({ where: { userId: a.user.id } });
  await prisma.e2eeSerrure.deleteMany({ where: { userId: a.user.id } });

  /* ── ① RIEN AVANT UNE SERRURE ────────────────────────────────────── */
  titre("① On ne dépose pas dans un coffre sans serrure");

  const sansSerrure = await api("/api/e2ee/archive", {
    method: "POST",
    body: { iv: "aXYtZGUtZG91emUh", contenu: "blocOpaque", nbMessages: 3 },
  });
  verifie(
    "le dépôt est refusé",
    sansSerrure.statut === 409 && sansSerrure.corps.includes("SANS_SERRURE"),
    `HTTP ${sansSerrure.statut} ${sansSerrure.corps.slice(0, 100)}`,
  );

  /* ── ② LE PÉRIMÈTRE ──────────────────────────────────────────────── */
  titre("② Un compte hors périmètre n'a pas de coffre");

  const refus = await apiAgent("/api/e2ee/coffre", { method: "PUT", body: SERRURE("trousseau") });
  verifie(
    "un AGENT (type 2) ne peut pas poser de serrure",
    refus.statut === 403 && refus.corps.includes("HORS_PERIMETRE"),
    `HTTP ${refus.statut} ${refus.corps.slice(0, 100)}`,
  );

  const refusBloc = await apiAgent("/api/e2ee/archive", {
    method: "POST",
    body: { iv: "aXYtZGUtZG91emUh", contenu: "x", nbMessages: 1 },
  });
  verifie("ni déposer de bloc", refusBloc.statut === 403);

  /* ── ③ POSER LES TROIS SERRURES ──────────────────────────────────── */
  titre("③ Trois serrures, et une seule par type");

  for (const type of ["trousseau", "motdepasse", "recuperation"]) {
    const r = await api("/api/e2ee/coffre", { method: "PUT", body: SERRURE(type) });
    verifie(`« ${type} » posée`, r.statut === 201, `HTTP ${r.statut} ${r.corps.slice(0, 80)}`);
  }

  const liste = await api("/api/e2ee/coffre");
  verifie("les trois sont là", liste.json?.serrures?.length === 3, JSON.stringify(liste.json));

  /*
   * 🔴 LE CONTRÔLE QUI PORTE LE CHANGEMENT DE MOT DE PASSE.
   *
   * Reposer la même serrure doit REMPLACER. Si elle s'ajoutait, l'ANCIEN mot de
   * passe ouvrirait encore l'archive — et en changer n'aurait rien changé.
   */
  const remplacee = { ...SERRURE("motdepasse"), cleEnveloppee: "bm91dmVsbGUtY2xlLWVudmVsb3BwZWU=" };
  await api("/api/e2ee/coffre", { method: "PUT", body: remplacee });
  const apres = await api("/api/e2ee/coffre");
  verifie(
    "reposer la même serrure REMPLACE, n'ajoute pas",
    apres.json?.serrures?.length === 3,
    `${apres.json?.serrures?.length} serrures — l'ancien secret ouvrirait encore`,
  );
  verifie(
    "et c'est bien la nouvelle valeur",
    apres.json.serrures.find((s) => s.type === "motdepasse").cleEnveloppee ===
      "bm91dmVsbGUtY2xlLWVudmVsb3BwZWU=",
  );

  const inconnu = await api("/api/e2ee/coffre", { method: "PUT", body: SERRURE("porte-derobee") });
  verifie("un type inconnu est refusé", inconnu.statut === 400, `HTTP ${inconnu.statut}`);

  /* ── ④ DÉPOSER ET RELIRE ─────────────────────────────────────────── */
  titre("④ Déposer des blocs, les relire dans l'ordre");

  for (const n of [1, 2, 3]) {
    const r = await api("/api/e2ee/archive", {
      method: "POST",
      body: { iv: "aXYtZGUtZG91emUh", contenu: `bloc-${n}`, nbMessages: n },
    });
    verifie(`bloc ${n} déposé`, r.statut === 201, `HTTP ${r.statut} ${r.corps.slice(0, 80)}`);
  }

  const relus = await api("/api/e2ee/archive");
  verifie("trois blocs relus", relus.json?.blocs?.length === 3);
  verifie(
    "du plus ancien au plus récent",
    relus.json.blocs.map((b) => b.contenu).join(",") === "bloc-1,bloc-2,bloc-3",
    relus.json.blocs.map((b) => b.contenu).join(","),
  );

  const trop = await api("/api/e2ee/archive", {
    method: "POST",
    body: { iv: "aXYtZGUtZG91emUh", contenu: "x".repeat(600 * 1024), nbMessages: 1 },
  });
  verifie("un bloc trop gros est refusé", trop.statut === 413, `HTTP ${trop.statut}`);

  /* ── ⑤ ON NE SE CONDAMNE PAS SOI-MÊME ────────────────────────────── */
  titre("⑤ La garde qui empêche de perdre son archive");

  for (const type of ["recuperation", "motdepasse"]) {
    const r = await api(`/api/e2ee/coffre?type=${type}`, { method: "DELETE" });
    verifie(`« ${type} » retirée`, r.statut === 200, `HTTP ${r.statut}`);
  }

  /*
   * 🔴 LE CONTRÔLE LE PLUS IMPORTANT DE CE BANC.
   *
   * Retirer la DERNIÈRE serrure rendrait l'archive illisible pour toujours —
   * par son propriétaire comme par nous. Ce n'est pas une suppression, c'est une
   * destruction silencieuse, et elle arriverait à quelqu'un qui « fait le
   * ménage » dans ses réglages.
   */
  const derniere = await api("/api/e2ee/coffre?type=trousseau", { method: "DELETE" });
  verifie(
    "retirer la DERNIÈRE serrure est refusé",
    derniere.statut === 409 && derniere.corps.includes("DERNIERE_SERRURE"),
    `HTTP ${derniere.statut} ${derniere.corps.slice(0, 120)}`,
  );

  const toujours = await api("/api/e2ee/coffre");
  verifie("elle est toujours là", toujours.json?.serrures?.length === 1);

  /* ── ⑥ TOUT EFFACER, EXPLICITEMENT ───────────────────────────────── */
  titre("⑥ Tout effacer emporte les blocs ET les serrures");

  const menage = await api("/api/e2ee/archive", { method: "DELETE" });
  verifie(
    "les deux partent ensemble",
    menage.json?.blocsSupprimes === 3 && menage.json?.serruresSupprimees === 1,
    JSON.stringify(menage.json),
  );

  const vide = await api("/api/e2ee/coffre");
  verifie("plus aucune serrure", vide.json?.serrures?.length === 0);
  const videBlocs = await api("/api/e2ee/archive");
  verifie("plus aucun bloc", videBlocs.json?.blocs?.length === 0);

  /* ── ⑦ L'ARCHIVE D'AUTRUI ────────────────────────────────────────── */
  titre("⑦ On ne voit que la sienne");

  await api("/api/e2ee/coffre", { method: "PUT", body: SERRURE("trousseau") });
  await api("/api/e2ee/archive", {
    method: "POST",
    body: { iv: "aXYtZGUtZG91emUh", contenu: "secret-d-alice", nbMessages: 1 },
  });

  const b = await compte("bob");
  const apiBob = appel(b.jeton);
  const chezBob = await apiBob("/api/e2ee/archive");
  verifie(
    "Bob ne voit rien de l'archive d'Alice",
    !JSON.stringify(chezBob.json).includes("secret-d-alice"),
    "l'archive d'un autre compte est visible",
  );

  /* ── NETTOYAGE ───────────────────────────────────────────────────── */
  await api("/api/e2ee/archive", { method: "DELETE" });

  console.log(
    `\n\x1b[1m════ ${echecs === 0 ? "\x1b[32mTOUT EST VERT" : `\x1b[31m${echecs} ÉCHEC(S)`}\x1b[0m\x1b[1m ════\x1b[0m\n`,
  );
  await prisma.$disconnect();
  process.exit(echecs === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\n\x1b[31m💥 Le banc s'est arrêté :\x1b[0m", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
