/**
 * BANC — LA ROTATION DU JETON DE RENOUVELLEMENT et ses trois rejeux (10/10/2026).
 *
 *   ① rejeu IMMÉDIAT (réponse perdue, réessai dans les 30 s) : accepté ;
 *   ② rejeu TARDIF, successeur jamais servi (appli tuée pendant l'installation
 *     d'un APK, rouverte 1 h 42 plus tard — le cas réel du 10/10) :
 *     401 JETON_DEJA_TOURNE, et non plus BAD_REFRESH, qui faisait tourner
 *     l'application en rond ;
 *   ③ rejeu TARDIF, successeur déjà servi (deux porteurs du même jeton) :
 *     401 JETON_REJOUE, et toute la chaîne de l'appareil est coupée.
 *
 * Usage :
 *   node --env-file=.env scripts/rotation-jeton-banc.mjs
 *       (serveur Next :3000 démarré)
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const API = process.env.API_URL ?? "http://localhost:3000";
const prisma = new PrismaClient();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

let echecs = 0;
function verifie(libelle, condition, detail) {
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${libelle}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      \x1b[31m${detail}\x1b[0m`);
  }
}
const titre = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const email = "rotation@banc.test";
const motDePasse = "MotDePasseDeTest!2026";
await prisma.user.upsert({
  where: { email },
  update: { passwordHash: await bcrypt.hash(motDePasse, 12), emailVerified: true, typeCompte: 0 },
  create: {
    email,
    nom: "Banc rotation",
    passwordHash: await bcrypt.hash(motDePasse, 12),
    publicNumber: `8${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
    emailVerified: true,
    typeCompte: 0,
  },
});

async function connexion(appareil) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": `10.96.${Math.floor(Math.random() * 250)}.1` },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: appareil, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login → ${r.status} ${await r.text()}`);
  return (await r.json()).refreshToken;
}

const renouveler = (jeton) =>
  fetch(`${API}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: jeton }),
  }).then(async (r) => ({ statut: r.status, corps: await r.json() }));

/** Fait comme si la rotation de [jeton] avait eu lieu il y a [ms]. */
const vieillir = (jeton, ms) =>
  prisma.refreshToken.updateMany({
    where: { tokenHash: sha(jeton) },
    data: { rotatedAt: new Date(Date.now() - ms) },
  });

titre("① Rejeu immédiat : la réponse s'est perdue, on réessaie");
{
  const t0 = await connexion(`banc-rotation-1-${Date.now()}`);
  const r1 = await renouveler(t0);
  verifie("première rotation : 200", r1.statut === 200, JSON.stringify(r1.corps));
  const r2 = await renouveler(t0);
  verifie("le même jeton, aussitôt : encore 200 (fenêtre de grâce)", r2.statut === 200, JSON.stringify(r2.corps));
}

titre("② Rejeu tardif, successeur jamais servi : l'APK installé pendant la rotation");
{
  const t0 = await connexion(`banc-rotation-2-${Date.now()}`);
  const r1 = await renouveler(t0);
  verifie("rotation : 200", r1.statut === 200);
  // 1 h 42 plus tard, comme sur le téléphone : le successeur (r1) n'a jamais servi.
  await vieillir(t0, (60 + 42) * 60 * 1000);
  const r2 = await renouveler(t0);
  verifie("401", r2.statut === 401, r2.statut);
  verifie("NOMMÉ : JETON_DEJA_TOURNE (et non BAD_REFRESH)", r2.corps.error?.code === "JETON_DEJA_TOURNE", JSON.stringify(r2.corps));
  const successeur = await renouveler(r1.corps.refreshToken);
  verifie("le successeur, lui, n'a pas été coupé (rien d'une attaque)", successeur.statut === 200, JSON.stringify(successeur.corps));
}

titre("③ Rejeu tardif, successeur déjà servi : deux porteurs du même jeton");
{
  const appareil = `banc-rotation-3-${Date.now()}`;
  const t0 = await connexion(appareil);
  const r1 = await renouveler(t0);
  const r2 = await renouveler(r1.corps.refreshToken);
  verifie("deux rotations : 200, 200", r1.statut === 200 && r2.statut === 200);
  await vieillir(t0, 5 * 60 * 1000);
  const r3 = await renouveler(t0);
  verifie("401 JETON_REJOUE (inchangé)", r3.statut === 401 && r3.corps.error?.code === "JETON_REJOUE", JSON.stringify(r3.corps));
  const r4 = await renouveler(r2.corps.refreshToken);
  verifie("toute la chaîne de l'appareil est coupée", r4.statut === 401, JSON.stringify(r4.corps));
}

await prisma.$disconnect();
console.log(echecs === 0 ? "\n\x1b[32mTous les contrôles passent.\x1b[0m" : `\n\x1b[31m${echecs} ÉCHEC(S).\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
