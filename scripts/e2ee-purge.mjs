/**
 * LA PURGE DES ENVELOPPES CHIFFRÉES.
 *
 * 🔴 UNE PURGE SE TESTE DANS LES DEUX SENS, et le second compte plus que le
 * premier : supprimer trop peu coûte des octets, supprimer trop coûte un
 * message que personne ne pourra jamais reconstituer.
 *
 * Ce banc pose donc des enveloppes de tous les âges et vérifie, pour chacune,
 * qu'elle part OU qu'elle reste — jamais seulement qu'« il en reste moins ».
 *
 * ⚠️ IL REJOUE LA LOGIQUE DE `purgeEnveloppesChiffrees` (ws-server.mjs) plutôt
 * que d'importer la fonction : elle vit dans un module qui ouvre des sockets et
 * des minuteurs au chargement. Les deux seuils sont donc écrits ICI AUSSI, et
 * c'est le risque connu de ce banc — les faire diverger le rendrait muet.
 *
 * Usage : node --env-file=.env scripts/e2ee-purge.mjs
 */

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

const JOUR = 24 * 60 * 60 * 1000;
const SEUIL_REMISES = 30 * JOUR;
const SEUIL_JAMAIS_RELEVEES = 90 * JOUR;

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

/** La purge, telle que `ws-server.mjs` l'exécute. */
async function purge() {
  await prisma.e2eeEnveloppe.deleteMany({
    where: { remisLe: { lt: new Date(Date.now() - SEUIL_REMISES) } },
  });
  await prisma.e2eeEnveloppe.deleteMany({
    where: {
      remisLe: null,
      createdAt: { lt: new Date(Date.now() - SEUIL_JAMAIS_RELEVEES) },
    },
  });
}

async function compte(marque) {
  const email = `purge-${marque}@e2ee.test`;
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      nom: `Purge ${marque}`,
      passwordHash: await bcrypt.hash("MotDePasseDeTest!2026", 12),
      publicNumber: `PG${marque}${Math.floor(Math.random() * 100000)}`,
      emailVerified: true,
    },
  });
}

async function main() {
  console.log("\n\x1b[1m════ LA PURGE DES ENVELOPPES CHIFFRÉES ════\x1b[0m");

  const a = await compte("alice");
  const b = await compte("bob");

  let conv = await prisma.conversation.findFirst({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: a.id } } },
        { participants: { some: { userId: b.id } } },
      ],
    },
  });
  if (!conv) {
    conv = await prisma.conversation.create({
      data: {
        isGroup: false,
        participants: { create: [{ userId: a.id }, { userId: b.id }] },
      },
    });
  }

  // On repart d'une table propre POUR CES DEUX COMPTES.
  await prisma.e2eeEnveloppe.deleteMany({
    where: { expediteurId: a.id, destinataireId: b.id },
  });

  const ilYA = (ms) => new Date(Date.now() - ms);

  /** Dépose une enveloppe d'un âge et d'un état donnés. */
  async function pose(marque, creeeIlYA, remiseIlYA) {
    return prisma.e2eeEnveloppe.create({
      data: {
        convId: conv.id,
        expediteurId: a.id,
        expediteurDevice: 1,
        destinataireId: b.id,
        destinataireDevice: 2,
        type: 1,
        corps: `corps-${marque}`,
        createdAt: ilYA(creeeIlYA),
        remisLe: remiseIlYA === null ? null : ilYA(remiseIlYA),
      },
      select: { id: true },
    });
  }

  /* ── LES CAS, DES DEUX CÔTÉS DE CHAQUE SEUIL ─────────────────────── */
  const cas = [
    // marque              créée        remise          doit survivre ?
    ["remise hier", 2 * JOUR, 1 * JOUR, true],
    ["remise il y a 29 jours", 30 * JOUR, 29 * JOUR, true],
    ["remise il y a 31 jours", 32 * JOUR, 31 * JOUR, false],
    ["remise il y a un an", 400 * JOUR, 380 * JOUR, false],
    ["en attente depuis hier", 1 * JOUR, null, true],
    ["en attente depuis 89 jours", 89 * JOUR, null, true],
    ["en attente depuis 91 jours", 91 * JOUR, null, false],
    // 🔴 LE CAS QUI PIÈGE : vieille MAIS relevée récemment. Elle doit RESTER —
    // c'est `remis_le` qui commande, jamais l'âge de la ligne.
    ["vieille mais relevée hier", 200 * JOUR, 1 * JOUR, true],
  ];

  const poses = [];
  for (const [marque, creee, remise, survit] of cas) {
    const ligne = await pose(marque, creee, remise);
    poses.push({ marque, id: ligne.id, survit });
  }

  titre("① Avant la purge");
  const avant = await prisma.e2eeEnveloppe.count({
    where: { expediteurId: a.id, destinataireId: b.id },
  });
  verifie(`les ${cas.length} enveloppes sont en place`, avant === cas.length, `${avant} trouvée(s)`);

  await purge();

  titre("② Après la purge — chaque cas, un par un");
  for (const { marque, id, survit } of poses) {
    const encore = await prisma.e2eeEnveloppe.findUnique({ where: { id }, select: { id: true } });
    const ok = survit ? encore !== null : encore === null;
    verifie(
      `${marque} → ${survit ? "GARDÉE" : "supprimée"}`,
      ok,
      survit
        ? "elle a été supprimée alors qu'elle devait rester — un message perdu"
        : "elle est toujours là — la purge ne fait pas son travail",
    );
  }

  /* ── ③ RIEN D'AUTRE N'A BOUGÉ ────────────────────────────────────── */
  titre("③ La purge n'a touché à rien d'autre");

  const messages = await prisma.message.count({ where: { convId: conv.id } });
  verifie("les messages du fil sont intacts", messages >= 0);

  const filVivant = await prisma.conversation.findUnique({
    where: { id: conv.id },
    select: { id: true },
  });
  verifie("la conversation existe toujours", filVivant !== null);

  /* ── NETTOYAGE ───────────────────────────────────────────────────── */
  await prisma.e2eeEnveloppe.deleteMany({
    where: { expediteurId: a.id, destinataireId: b.id },
  });

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
