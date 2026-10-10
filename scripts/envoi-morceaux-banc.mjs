/**
 * BANC — ENVOI DE FICHIERS EN MORCEAUX, contre le vrai serveur (10/10/2026).
 *
 *   ① réservation : découpage décidé par le serveur, jeton rendu ;
 *   ② morceaux dans le désordre, en parallèle, en double : comptés une fois ;
 *   ③ morceau COUPÉ en route (corps trop court) : pas marqué reçu ;
 *   ④ morceau trop long, numéro illisible, numéro hors bornes : refusés ;
 *   ⑤ accès : jeton faux et compte étranger → 404 ; propriétaire → 200 ;
 *   ⑥ dernier morceau : le média est rendu, ses octets sont IDENTIQUES à
 *     l'original, le fichier provisoire a disparu du disque ;
 *   ⑦ morceau rejoué après la fin : même média, rien de plus ;
 *   ⑧ tous les morceaux EN MÊME TEMPS : un seul média créé ;
 *   ⑨ empreinte fausse : refus, et tout redevient « manquant » ;
 *   ⑩ fichier chiffré : rangé sous un nom et un type neutres ;
 *   ⑪ abandon : la ligne et le fichier disparaissent ;
 *   ⑫ expiration : un envoi muet depuis 8 jours est effacé au passage ;
 *   ⑬ non-régression : `POST /api/media` (un seul bloc) marche toujours.
 *
 * Usage :
 *   node --env-file=.env scripts/envoi-morceaux-banc.mjs
 *       (serveur Next :3000 démarré, stockage LOCAL)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const API = process.env.API_URL ?? "http://localhost:3000";
const DOSSIER_ENVOIS = process.env.ENVOIS_MORCEAUX_DIR ?? "./storage/envois";
const prisma = new PrismaClient();

let echecs = 0;
function verifie(libelle, condition, detail) {
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${libelle}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      \x1b[31m${detail}\x1b[0m`);
  }
}
const titre = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

async function compte(marque) {
  const email = `em-${marque}@banc.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const hash = await bcrypt.hash(motDePasse, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Morceaux ${marque}`,
      passwordHash: hash,
      publicNumber: `8${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `banc-morceaux-${marque}`, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`);
  return { user, jeton: (await r.json()).accessToken };
}

async function reserver(qui, fichier, extra = {}) {
  const r = await fetch(`${API}/api/media/envois`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${qui.jeton}` },
    body: JSON.stringify({ taille: fichier.length, nom: "video.mp4", mime: "video/mp4", empreinte: sha(fichier), ...extra }),
  });
  return { statut: r.status, corps: await r.json() };
}

function morceau(envoi, fichier, n, { methode = "PUT", jeton = envoi.jeton, corps } = {}) {
  const debut = n * envoi.tailleMorceau;
  const octets = corps ?? fichier.subarray(debut, Math.min(debut + envoi.tailleMorceau, fichier.length));
  return fetch(`${API}/api/media/envois/${envoi.id}/morceaux/${n}`, {
    method: methode,
    headers: { "Content-Type": "application/octet-stream", "X-Envoi-Jeton": jeton },
    body: octets,
  }).then(async (r) => ({ statut: r.status, corps: await r.json() }));
}

const etat = (envoi, entetes) =>
  fetch(`${API}/api/media/envois/${envoi.id}`, { headers: entetes }).then(async (r) => ({
    statut: r.status,
    corps: await r.json(),
  }));

async function telecharger(qui, mediaId) {
  const r = await fetch(`${API}/api/media/${mediaId}`, { headers: { Authorization: `Bearer ${qui.jeton}` } });
  return Buffer.from(await r.arrayBuffer());
}

const tampon = (id) => join(DOSSIER_ENVOIS, `${id}.bin`);

// -----------------------------------------------------------------------------
const a = await compte("a");
const b = await compte("b");
const Mo = 1024 * 1024;
const fichier = crypto.randomBytes(2 * Mo + Mo / 2 + 37); // 3 morceaux, le dernier court

titre("① Réservation");
const r1 = await reserver(a, fichier);
const e1 = r1.corps;
verifie("201 Created", r1.statut === 201, JSON.stringify(r1.corps));
verifie("morceaux de 1 Mio", e1.tailleMorceau === Mo, e1.tailleMorceau);
verifie("3 morceaux pour 2,5 Mio + 37 octets", e1.nbMorceaux === 3, e1.nbMorceaux);
verifie("un jeton d'envoi est rendu", typeof e1.jeton === "string" && e1.jeton.length >= 40);
verifie("le fichier provisoire existe déjà sur disque", existsSync(tampon(e1.id)));
const ligne = await prisma.envoiMorceaux.findUnique({ where: { id: e1.id } });
verifie("le jeton n'est PAS gardé en clair en base", ligne && ligne.jetonHash !== e1.jeton && ligne.jetonHash === sha(e1.jeton));

titre("② Désordre, parallèle, doublon");
const [m2, m0, m0bis] = await Promise.all([
  morceau(e1, fichier, 2),
  morceau(e1, fichier, 0, { methode: "POST" }),
  morceau(e1, fichier, 0),
]);
verifie("morceau 2 (le dernier, court) accepté", m2.statut === 200, JSON.stringify(m2.corps));
verifie("morceau 0 accepté en POST et en PUT", m0.statut === 200 && m0bis.statut === 200);
const s2 = await etat(e1, { "X-Envoi-Jeton": e1.jeton });
verifie("2 reçus, pas 3 : le doublon ne compte pas", s2.corps.recus === 2, JSON.stringify(s2.corps));
verifie("il manque le morceau 1", JSON.stringify(s2.corps.manquants) === "[1]");
verifie("pas encore terminé", s2.corps.statut === "en_cours" && !s2.corps.media);

titre("③ Morceau coupé en route");
const coupe = await morceau(e1, fichier, 1, { corps: fichier.subarray(Mo, Mo + Mo / 2) });
verifie("400 MORCEAU_INCOMPLET", coupe.statut === 400 && coupe.corps.error?.code === "MORCEAU_INCOMPLET", JSON.stringify(coupe.corps));
const s3 = await etat(e1, { "X-Envoi-Jeton": e1.jeton });
verifie("le morceau 1 manque toujours", JSON.stringify(s3.corps.manquants) === "[1]");

// L'ascenseur : la connexion tombe au milieu du morceau, sans fin propre.
const coupure = new AbortController();
const flux = new ReadableStream({
  start(c) {
    c.enqueue(fichier.subarray(Mo, Mo + 300 * 1024));
    setTimeout(() => coupure.abort(), 300);
  },
});
await fetch(`${API}/api/media/envois/${e1.id}/morceaux/1`, {
  method: "PUT",
  headers: { "Content-Type": "application/octet-stream", "X-Envoi-Jeton": e1.jeton },
  body: flux,
  duplex: "half",
  signal: coupure.signal,
}).catch(() => {});
await new Promise((r) => setTimeout(r, 500));
const s3b = await etat(e1, { "X-Envoi-Jeton": e1.jeton });
verifie("connexion coupée net : le serveur répond encore, morceau 1 toujours manquant",
  s3b.statut === 200 && JSON.stringify(s3b.corps.manquants) === "[1]", JSON.stringify(s3b.corps));

titre("④ Refus");
const long = await morceau(e1, fichier, 2, { corps: crypto.randomBytes(Mo) });
verifie("dernier morceau trop long → 413", long.statut === 413, JSON.stringify(long.corps));
const illisible = await fetch(`${API}/api/media/envois/${e1.id}/morceaux/1e3`, {
  method: "PUT", headers: { "X-Envoi-Jeton": e1.jeton }, body: "x",
});
verifie("numéro « 1e3 » → 400", illisible.status === 400);
const horsBornes = await morceau(e1, fichier, 3, { corps: Buffer.from("x") });
verifie("morceau 3 d'un envoi de 3 → 404", horsBornes.statut === 404);
// Le morceau trop long a réécrit le début du morceau 2 : on le renvoie juste.
await morceau(e1, fichier, 2);

titre("⑤ Accès");
const faux = await morceau(e1, fichier, 1, { jeton: "faux-jeton" });
verifie("jeton faux → 404, rien d'écrit", faux.statut === 404 && faux.corps.error?.code === "ENVOI_INCONNU");
const etranger = await etat(e1, { Authorization: `Bearer ${b.jeton}` });
verifie("un autre compte ne voit pas l'envoi (404)", etranger.statut === 404);
const proprio = await etat(e1, { Authorization: `Bearer ${a.jeton}` });
verifie("le propriétaire le voit avec son jeton d'accès", proprio.statut === 200);
const sansRien = await etat(e1, {});
verifie("sans aucun jeton → 401", sansRien.statut === 401);

titre("⑥ Dernier morceau : le média");
const fin = await morceau(e1, fichier, 1);
verifie("terminé", fin.statut === 200 && fin.corps.termine === true, JSON.stringify(fin.corps));
verifie("le média est rendu", typeof fin.corps.media?.id === "string");
verifie("taille et type du média", fin.corps.media?.sizeBytes === fichier.length && fin.corps.media?.mimeType === "video/mp4");
const recu = await telecharger(a, fin.corps.media.id);
verifie("octets IDENTIQUES à l'original (SHA-256)", sha(recu) === sha(fichier), `${recu.length} octets`);
verifie("le fichier provisoire a disparu du disque", !existsSync(tampon(e1.id)));

titre("⑦ Morceau rejoué après la fin");
const rejeu = await morceau(e1, fichier, 0);
verifie("200, même média", rejeu.statut === 200 && rejeu.corps.media?.id === fin.corps.media.id, JSON.stringify(rejeu.corps));

titre("⑧ Tous les morceaux en même temps");
const gros = crypto.randomBytes(6 * Mo - 5);
const e8 = (await reserver(a, gros)).corps;
const avant = await prisma.mediaFile.count({ where: { ownerId: a.user.id } });
const tous = await Promise.all([0, 1, 2, 3, 4, 5].map((n) => morceau(e8, gros, n)));
const apres = await prisma.mediaFile.count({ where: { ownerId: a.user.id } });
verifie("tous acceptés", tous.every((r) => r.statut === 200), tous.map((r) => r.statut).join(","));
verifie("UN SEUL média créé", apres - avant === 1, `${apres - avant} médias`);
const s8 = await etat(e8, { "X-Envoi-Jeton": e8.jeton });
verifie("l'envoi est terminé et porte son média", s8.corps.statut === "termine" && s8.corps.media?.id);
verifie("octets identiques", sha(await telecharger(a, s8.corps.media.id)) === sha(gros));

titre("⑨ Empreinte fausse");
const petit = crypto.randomBytes(Mo + 10);
const e9 = (await reserver(a, petit, { empreinte: "0".repeat(64) })).corps;
await morceau(e9, petit, 0);
const faux9 = await morceau(e9, petit, 1);
verifie("422 EMPREINTE_FAUSSE", faux9.statut === 422 && faux9.corps.error?.code === "EMPREINTE_FAUSSE", JSON.stringify(faux9.corps));
const s9 = await etat(e9, { "X-Envoi-Jeton": e9.jeton });
verifie("tout redevient manquant", JSON.stringify(s9.corps.manquants) === "[0,1]" && s9.corps.statut === "en_cours", JSON.stringify(s9.corps));

titre("⑩ Fichier chiffré");
const chiffre = crypto.randomBytes(300 * 1024);
const e10 = (await reserver(a, chiffre, { chiffre: true, nom: "vacances.jpg", mime: "image/jpeg" })).corps;
const fin10 = await morceau(e10, chiffre, 0);
const m10 = await prisma.mediaFile.findUnique({ where: { id: fin10.corps.media?.id ?? "00000000-0000-0000-0000-000000000000" } });
verifie("rangé sous un nom neutre", m10?.filename === "chiffre.bin", m10?.filename);
verifie("et un type neutre", m10?.mimeType === "application/octet-stream" && m10?.chiffre === true);

titre("⑪ Abandon");
const e11 = (await reserver(a, petit)).corps;
await morceau(e11, petit, 0);
const del = await fetch(`${API}/api/media/envois/${e11.id}`, { method: "DELETE", headers: { "X-Envoi-Jeton": e11.jeton } });
verifie("200", del.status === 200);
verifie("le fichier partiel a disparu", !existsSync(tampon(e11.id)));
verifie("la ligne aussi", (await prisma.envoiMorceaux.findUnique({ where: { id: e11.id } })) === null);

titre("⑫ Expiration");
const e12 = (await reserver(a, petit)).corps;
await prisma.envoiMorceaux.update({ where: { id: e12.id }, data: { majLe: new Date(Date.now() - 8 * 24 * 3600 * 1000) } });
await reserver(a, Buffer.from("déclencheur")); // chaque réservation fait le ménage
verifie("l'envoi muet depuis 8 jours est effacé", (await prisma.envoiMorceaux.findUnique({ where: { id: e12.id } })) === null);
verifie("son fichier aussi", !existsSync(tampon(e12.id)));

titre("⑬ Non-régression : POST /api/media");
const form = new FormData();
const bloc = crypto.randomBytes(50 * 1024);
form.append("file", new Blob([bloc], { type: "image/png" }), "photo.png");
const classique = await fetch(`${API}/api/media`, { method: "POST", headers: { Authorization: `Bearer ${a.jeton}` }, body: form });
const cc = await classique.json();
verifie("201 et même forme de réponse", classique.status === 201 && cc.url === `/api/media/${cc.id}` && cc.mimeType === "image/png" && cc.sizeBytes === bloc.length, JSON.stringify(cc));
verifie("octets identiques", sha(await telecharger(a, cc.id)) === sha(bloc));

// Ménage : les envois du banc (leurs médias restent, comme tout média envoyé).
await prisma.envoiMorceaux.deleteMany({ where: { ownerId: a.user.id } });
await prisma.$disconnect();
console.log(echecs === 0 ? "\n\x1b[32mTous les contrôles passent.\x1b[0m" : `\n\x1b[31m${echecs} ÉCHEC(S).\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
