/**
 * PUBLICATION SUR LE PLAY STORE (18/11/2026) — les routes ajoutées.
 *
 *   ① GET /api/legal/:slug répond SANS connexion, version d'origine comprise ;
 *     une page inconnue rend 404 ;
 *   ② signaler un GROUPE : seulement un membre ; une seule fois tant que c'est
 *     ouvert ;
 *   ③ signaler une réponse de l'ASSISTANT : seulement la sienne, et son texte
 *     exact part dans le dossier ;
 *   ④ POST /api/account/suppression (sans application) : mauvais mot de passe
 *     refusé, compte inconnu refusé de la même façon, bon mot de passe →
 *     compte supprimé.
 *
 * ⚠️ JAMAIS SUR LA BASE DE PRODUCTION : il refuse toute base autre que
 * `alanya_banc` ou `alanya_dev`.
 *
 * Usage : API_URL=http://127.0.0.1:3100 node scripts/play-store-banc.mjs
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const API = process.env.API_URL ?? "http://localhost:3000";
const base = (process.env.DATABASE_URL ?? "").split("?")[0].split("/").pop();
if (base !== "alanya_banc" && base !== "alanya_dev") {
  console.error(`\x1b[31mRefusé : la base « ${base} » n'est pas une base de test.\x1b[0m`);
  process.exit(2);
}

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
const MDP = "MotDePasseDeTest!2026";

async function compte(marque) {
  const email = `store-${marque}@e2ee.test`;
  const hash = await bcrypt.hash(MDP, 10);
  return prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Store ${marque}`,
      passwordHash: hash,
      publicNumber: `${Math.floor(10000000 + Math.random() * 89999999)}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
}

async function jeton(user) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: user.email, password: MDP, deviceId: `store-${user.id.slice(0, 8)}`, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login → ${r.status} ${await r.text()}`);
  return (await r.json()).accessToken;
}

async function appel(j, methode, chemin, corps) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(j ? { Authorization: `Bearer ${j}` } : {}) },
    ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
  });
  const texte = await r.text();
  let json = null;
  try {
    json = JSON.parse(texte);
  } catch {}
  return { statut: r.status, json, texte };
}

async function nettoyer(ids) {
  await prisma.gestionSignalement.deleteMany({ where: { auteurId: { in: ids } } });
  const convs = await prisma.participant.findMany({ where: { userId: { in: ids } }, select: { convId: true } });
  await prisma.conversation.deleteMany({ where: { id: { in: convs.map((c) => c.convId) } } });
  await prisma.aiThread.deleteMany({ where: { userId: { in: ids } } });
}

async function main() {
  console.log("\n\x1b[1m════ PLAY STORE : PAGES LÉGALES, SIGNALEMENTS, SUPPRESSION ════\x1b[0m");

  titre("① Les pages légales, sans connexion");
  for (const slug of ["confidentialite", "conditions"]) {
    const r = await appel(null, "GET", `/api/legal/${slug}`);
    verifie(
      `/api/legal/${slug} : 200, un titre et un texte`,
      r.statut === 200 && r.json?.titre && (r.json?.contenu ?? "").length > 200,
      r.texte.slice(0, 160),
    );
  }
  const inconnue = await appel(null, "GET", "/api/legal/secret");
  verifie("page inconnue : 404", inconnue.statut === 404, `HTTP ${inconnue.statut}`);

  const alice = await compte("alice");
  const bob = await compte("bob");
  const intrus = await compte("intrus");
  await nettoyer([alice.id, bob.id, intrus.id]);
  const jA = await jeton(alice);
  const jI = await jeton(intrus);

  titre("② Signaler un groupe");
  const g = await prisma.conversation.create({
    data: {
      isGroup: true,
      name: "Groupe signalé",
      description: "description du groupe",
      participants: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
    select: { id: true },
  });
  const s1 = await appel(jA, "POST", "/api/signalements", { cible: "group", convId: g.id, motif: "hate" });
  verifie("un membre signale : 201", s1.statut === 201, s1.texte.slice(0, 160));
  const dossier = await prisma.gestionSignalement.findFirst({ where: { auteurId: alice.id, cibleType: "group" } });
  verifie(
    "le dossier porte le groupe, son nom et sa description",
    dossier?.cibleId === g.id && (dossier?.extrait ?? "").includes("Groupe signalé"),
    JSON.stringify(dossier),
  );
  const s2 = await appel(jA, "POST", "/api/signalements", { cible: "group", convId: g.id, motif: "spam" });
  verifie("une seconde fois tant que c'est ouvert : 409", s2.statut === 409, `HTTP ${s2.statut}`);
  const s3 = await appel(jI, "POST", "/api/signalements", { cible: "group", convId: g.id, motif: "hate" });
  verifie("un non-membre : 404", s3.statut === 404, `HTTP ${s3.statut}`);

  titre("③ Signaler une réponse de l'Assistant");
  const fil = await prisma.aiThread.create({ data: { userId: alice.id }, select: { id: true } });
  const question = await prisma.aiMessage.create({ data: { threadId: fil.id, role: "USER", content: "question" } });
  const reponse = await prisma.aiMessage.create({
    data: { threadId: fil.id, role: "MODEL", content: "une réponse choquante" },
  });
  const ia = await appel(jA, "POST", "/api/signalements", { cible: "ia", aiMessageId: reponse.id, motif: "violence" });
  verifie("sa propre réponse : 201", ia.statut === 201, ia.texte.slice(0, 160));
  const dossierIa = await prisma.gestionSignalement.findFirst({ where: { auteurId: alice.id, cibleType: "ia" } });
  verifie("son texte exact est au dossier", dossierIa?.extrait === "une réponse choquante", JSON.stringify(dossierIa));
  const iaQ = await appel(jA, "POST", "/api/signalements", { cible: "ia", aiMessageId: question.id, motif: "other" });
  verifie("sa propre QUESTION n'est pas une réponse : 404", iaQ.statut === 404, `HTTP ${iaQ.statut}`);
  const iaI = await appel(jI, "POST", "/api/signalements", { cible: "ia", aiMessageId: reponse.id, motif: "other" });
  verifie("la réponse d'un autre : 404", iaI.statut === 404, `HTTP ${iaI.statut}`);

  titre("④ Supprimer son compte depuis le web");
  const mauvais = await appel(null, "POST", "/api/account/suppression", { identifier: bob.email, password: "mauvais" });
  const inconnu = await appel(null, "POST", "/api/account/suppression", { identifier: "personne@e2ee.test", password: MDP });
  verifie(
    "mauvais mot de passe et compte inconnu : même refus",
    mauvais.statut === 400 && inconnu.statut === 400 && mauvais.json?.error?.code === inconnu.json?.error?.code,
    `${mauvais.statut} ${mauvais.texte.slice(0, 80)} / ${inconnu.statut} ${inconnu.texte.slice(0, 80)}`,
  );
  verifie("le compte existe toujours", (await prisma.user.count({ where: { id: bob.id } })) === 1);
  const ok = await appel(null, "POST", "/api/account/suppression", { identifier: bob.publicNumber, password: MDP });
  verifie("par l'Alanya ID et le bon mot de passe : supprimé", ok.statut === 200, ok.texte.slice(0, 160));
  verifie("le compte n'existe plus", (await prisma.user.count({ where: { id: bob.id } })) === 0);

  await nettoyer([alice.id, intrus.id]);
  console.log(echecs === 0 ? "\n\x1b[32m════ Tout passe ════\x1b[0m\n" : `\n\x1b[31m════ ${echecs} échec(s) ════\x1b[0m\n`);
}

main()
  .catch((e) => {
    console.error(e);
    echecs++;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exitCode = echecs === 0 ? 0 : 1;
  });
