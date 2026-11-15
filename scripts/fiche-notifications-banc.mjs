/**
 * LA FICHE CONTACT ET LES NOTIFICATIONS APRÈS DÉCONNEXION (15/11/2026).
 *
 *   ① GET /api/users/:id/fiche rend le statut et l'état réel du blocage ;
 *   ② elle ne dit jamais « elle m'a bloqué », et refuse un inconnu (404) ;
 *   ③ un jeton de notification sans session vivante n'est plus notifié, et
 *     il est supprimé ; un jeton d'appareil connecté, et un jeton ancien sans
 *     appareil, le restent ;
 *   ④ après une vraie déconnexion (POST /api/auth/logout), plus rien.
 *
 * ⚠️ JAMAIS SUR LA BASE DE PRODUCTION : il refuse toute base autre que
 * `alanya_banc` ou `alanya_dev`.
 *
 * Usage : node --env-file=.env.banc scripts/fiche-notifications-banc.mjs
 *         (API démarrée sur cette base ; API_URL, par défaut :3000)
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { tokensForUser } from "../push.mjs";

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

async function compte(marque, statusMsg = null) {
  const email = `fiche-${marque}@e2ee.test`;
  const hash = await bcrypt.hash(MDP, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0, statusMsg },
    create: {
      email,
      nom: `Fiche ${marque}`,
      passwordHash: hash,
      publicNumber: `${Math.floor(10000000 + Math.random() * 89999999)}`,
      emailVerified: true,
      typeCompte: 0,
      statusMsg,
    },
  });
  return user;
}

async function connexion(user, appareil) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: user.email, password: MDP, deviceId: appareil, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login → ${r.status} ${await r.text()}`);
  const j = await r.json();
  return { jeton: j.accessToken, refresh: j.refreshToken };
}

async function fiche(session, id) {
  const r = await fetch(`${API}/api/users/${id}/fiche`, {
    headers: { Authorization: `Bearer ${session.jeton}` },
  });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}
  return { statut: r.status, json: j, texte: t };
}

async function nettoyer(users) {
  const ids = users.map((u) => u.id);
  await prisma.blocked.deleteMany({ where: { OR: [{ alanyaID: { in: ids } }, { idCallerBlock: { in: ids } }] } });
  const convs = await prisma.participant.findMany({ where: { userId: { in: ids } }, select: { convId: true } });
  await prisma.conversation.deleteMany({ where: { id: { in: convs.map((c) => c.convId) } } });
  await prisma.pushDevice.deleteMany({ where: { userId: { in: ids } } });
  await prisma.contact.deleteMany({ where: { OR: [{ userId: { in: ids } }, { contactId: { in: ids } }] } });
}

async function main() {
  console.log("\n\x1b[1m════ FICHE CONTACT ET NOTIFICATIONS APRÈS DÉCONNEXION ════\x1b[0m");
  const alice = await compte("alice");
  const bob = await compte("bob", "Au bureau jusqu'à 18 h");
  const inconnu = await compte("inconnu", "secret");
  await nettoyer([alice, bob, inconnu]);
  // Alice et Bob partagent un groupe.
  await prisma.conversation.create({
    data: { isGroup: true, name: "Groupe fiche", participants: { create: [{ userId: alice.id }, { userId: bob.id }] } },
  });
  const sA = await connexion(alice, "fiche-alice-1");

  titre("① Statut et état réel du blocage");
  let f = await fiche(sA, bob.id);
  verifie("le statut de Bob", f.statut === 200 && f.json?.statusMsg === "Au bureau jusqu'à 18 h", f.texte.slice(0, 160));
  verifie("pas bloqué", f.json?.bloque === false);
  await prisma.blocked.create({ data: { alanyaID: alice.id, idCallerBlock: bob.id } });
  f = await fiche(sA, bob.id);
  verifie("après blocage : bloque = true", f.json?.bloque === true, f.texte.slice(0, 160));

  titre("② Ni « elle m'a bloqué », ni la fiche d'un inconnu");
  await prisma.blocked.deleteMany({ where: { alanyaID: alice.id } });
  await prisma.blocked.create({ data: { alanyaID: bob.id, idCallerBlock: alice.id } });
  f = await fiche(sA, bob.id);
  verifie("Bob a bloqué Alice : la fiche ne le dit pas", f.statut === 200 && f.json?.bloque === false, f.texte.slice(0, 160));
  f = await fiche(sA, inconnu.id);
  verifie("aucun lien avec l'inconnu : 404, statut non révélé", f.statut === 404 && !f.texte.includes("secret"), `HTTP ${f.statut}`);
  f = await fiche(sA, alice.id);
  verifie("sa propre fiche : 404", f.statut === 404, `HTTP ${f.statut}`);

  titre("③ Pas de session vivante, pas de notification");
  const sB = await connexion(bob, "fiche-bob-connecte");
  await prisma.pushDevice.createMany({
    data: [
      { userId: bob.id, token: "jeton-connecte", platform: "android", deviceId: "fiche-bob-connecte" },
      { userId: bob.id, token: "jeton-orphelin", platform: "android", deviceId: "fiche-bob-parti" },
      { userId: bob.id, token: "jeton-ancien", platform: "android", deviceId: null },
    ],
  });
  const jetons = await tokensForUser(prisma, bob.id);
  verifie(
    "notifiés : l'appareil connecté et le jeton ancien",
    jetons.length === 2 && jetons.includes("jeton-connecte") && jetons.includes("jeton-ancien"),
    JSON.stringify(jetons),
  );
  verifie(
    "le jeton sans session est supprimé",
    (await prisma.pushDevice.count({ where: { token: "jeton-orphelin" } })) === 0,
  );

  titre("④ Après une vraie déconnexion, plus rien");
  // Le jeton FCM renouvelé pendant la déconnexion, réenregistré trop tard :
  // il est rattaché à l'appareil, mais la session n'existe plus.
  await fetch(`${API}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: sB.refresh }),
  });
  await prisma.pushDevice.create({
    data: { userId: bob.id, token: "jeton-renouvele", platform: "android", deviceId: "fiche-bob-connecte" },
  });
  const apres = await tokensForUser(prisma, bob.id);
  verifie(
    "l'appareil déconnecté n'est plus notifié, même réenregistré",
    !apres.includes("jeton-connecte") && !apres.includes("jeton-renouvele"),
    JSON.stringify(apres),
  );

  await nettoyer([alice, bob, inconnu]);
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
