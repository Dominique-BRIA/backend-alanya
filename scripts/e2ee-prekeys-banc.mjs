/**
 * LE STOCK DE PRÉ-CLÉS D'UN COMPTE NE SE VIDE PAS DE L'EXTÉRIEUR.
 *
 * 🔴 CE QU'IL CHERCHE. Chaque paquet servi par `GET /api/e2ee/cles/<compte>`
 * CONSOMME une pré-clé unique. La route n'exigeait qu'une conversation en
 * commun — or n'importe qui en crée une avec un numéro public. Vider le stock
 * de quelqu'un dégrade toutes ses sessions suivantes (X3DH sans pré-clé
 * unique). Le banc ⑬ de `e2ee-banc.mjs` ne testait qu'un inconnu SANS
 * conversation : il donnait une fausse assurance.
 *
 *   ① témoin : dans un fil CHIFFRÉ, sans blocage, le paquet est servi ;
 *   ② un fil ordinaire (non chiffré) ne suffit plus pour CONSOMMER ;
 *     la liste des appareils (`?liste=1`), qui ne consomme rien, reste servie ;
 *   ③ un blocage, dans un sens ou dans l'autre, refuse le paquet ;
 *   ④ même autorisé, on ne vide pas un stock en boucle : débit limité par paire.
 *
 * Usage : node --env-file=.env scripts/e2ee-prekeys-banc.mjs   (backend :3000)
 *         ⚠️ Relancer `next dev` entre deux passages : la limite de débit vit
 *         en mémoire du serveur quand Redis est absent.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const API = process.env.API_URL ?? "http://localhost:3000";
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

async function compte(marque) {
  const email = `prekeys-${marque}@e2ee.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const hash = await bcrypt.hash(motDePasse, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Prekeys ${marque}`,
      passwordHash: hash,
      publicNumber: `PK${Math.floor(Math.random() * 1000000)}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
  await prisma.blocked.deleteMany({ where: { OR: [{ alanyaID: user.id }, { idCallerBlock: user.id }] } });
  await prisma.e2eeIdentite.deleteMany({ where: { userId: user.id } });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `prekeys-${marque}`, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`);
  return { user, jeton: (await r.json()).accessToken };
}

/** Une identité publiée, avec son stock de pré-clés — posée par la base. */
async function publier(qui, stock) {
  return prisma.e2eeIdentite.create({
    data: {
      userId: qui.user.id,
      deviceId: 1,
      registrationId: 4242,
      cleIdentite: "Y2xlLWQtaWRlbnRpdGU=",
      derniereReleve: new Date(),
      prekeysSignees: { create: [{ prekeyId: 1, clePublique: "c2lnbmVl", signature: "c2lnbmF0dXJl" }] },
      prekeysUniques: {
        create: Array.from({ length: stock }, (_, i) => ({ prekeyId: 100 + i, clePublique: `cHJla2V5${i}` })),
      },
    },
    select: { id: true },
  });
}

async function filEntre(a, b, chiffre) {
  const anciennes = await prisma.conversation.findMany({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: a.user.id } } },
        { participants: { some: { userId: b.user.id } } },
      ],
    },
    select: { id: true },
  });
  await prisma.conversation.deleteMany({ where: { id: { in: anciennes.map((c) => c.id) } } });
  const c = await prisma.conversation.create({
    data: {
      isGroup: false,
      e2eeActif: chiffre,
      participants: { create: [{ userId: a.user.id }, { userId: b.user.id }] },
    },
    select: { id: true },
  });
  return c.id;
}

async function paquet(qui, cible, requete = "?deviceIds=1") {
  const r = await fetch(`${API}/api/e2ee/cles/${cible.user.id}${requete}`, {
    headers: { Authorization: `Bearer ${qui.jeton}` },
  });
  return { statut: r.status, texte: await r.text() };
}

function libres(identite) {
  return prisma.e2eePrekeyUnique.count({ where: { identiteId: identite.id, consommeLe: null } });
}

async function main() {
  console.log("\n\x1b[1m════ LE STOCK DE PRÉ-CLÉS, VU DE L'EXTÉRIEUR ════\x1b[0m");

  const alice = await compte("alice");
  const bob = await compte("bob");
  const identiteBob = await publier(bob, 100);

  titre("① Témoin : dans un fil chiffré, le paquet est servi");
  const fil = await filEntre(alice, bob, true);
  let avant = await libres(identiteBob);
  const r1 = await paquet(alice, bob);
  verifie(
    "servi, et une pré-clé consommée",
    r1.statut === 200 && (await libres(identiteBob)) === avant - 1,
    `HTTP ${r1.statut} ${r1.texte.slice(0, 100)}`,
  );

  titre("② Un fil ORDINAIRE ne suffit plus pour consommer");
  await prisma.conversation.update({ where: { id: fil }, data: { e2eeActif: false } });
  avant = await libres(identiteBob);
  const r2 = await paquet(alice, bob);
  verifie(
    "refusé, et rien n'est consommé",
    r2.statut === 404 && (await libres(identiteBob)) === avant,
    `HTTP ${r2.statut} — ${avant - (await libres(identiteBob))} pré-clé(s) consommée(s)`,
  );
  const r2b = await paquet(alice, bob, "?liste=1");
  verifie("la liste des appareils, qui ne consomme rien, reste servie", r2b.statut === 200, `HTTP ${r2b.statut}`);
  await prisma.conversation.update({ where: { id: fil }, data: { e2eeActif: true } });

  titre("③ Un blocage refuse le paquet, dans les deux sens");
  for (const [libelle, bloqueur, bloque] of [
    ["Bob a bloqué Alice", bob, alice],
    ["Alice a bloqué Bob", alice, bob],
  ]) {
    await prisma.blocked.create({ data: { alanyaID: bloqueur.user.id, idCallerBlock: bloque.user.id } });
    avant = await libres(identiteBob);
    const r = await paquet(alice, bob);
    verifie(
      `${libelle} : refusé, rien de consommé`,
      r.statut === 404 && (await libres(identiteBob)) === avant,
      `HTTP ${r.statut}`,
    );
    await prisma.blocked.deleteMany({ where: { alanyaID: bloqueur.user.id } });
  }

  titre("④ Même autorisé, pas de vidage en boucle");
  avant = await libres(identiteBob);
  let servis = 0;
  let freine = false;
  for (let i = 0; i < 60; i++) {
    const r = await paquet(alice, bob);
    if (r.statut === 200) servis++;
    if (r.statut === 429) {
      freine = true;
      break;
    }
  }
  const consommees = avant - (await libres(identiteBob));
  verifie(
    "freiné bien avant d'avoir vidé le stock",
    freine && consommees <= 30,
    `${servis} paquet(s) servi(s), ${consommees} pré-clé(s) consommée(s) sur ${avant}`,
  );

  await prisma.e2eeIdentite.deleteMany({ where: { userId: bob.user.id } });
  await prisma.$disconnect();
  console.log(
    `\n\x1b[1m════ ${echecs === 0 ? "\x1b[32mTOUT EST VERT" : `\x1b[31m${echecs} ÉCHEC(S)`}\x1b[0m\x1b[1m ════\x1b[0m\n`,
  );
  process.exit(echecs === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\n\x1b[31m💥 Le banc s'est arrêté :\x1b[0m", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
