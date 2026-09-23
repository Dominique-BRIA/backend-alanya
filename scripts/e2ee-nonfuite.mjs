/**
 * LE BANC DE NON-FUITE.
 *
 * 🔴 CE BANC NE VÉRIFIE PAS QU'UNE FONCTIONNALITÉ MARCHE. Il vérifie que
 * quelque chose N'ARRIVE PAS — qu'un texte déchiffré ne sort pas par une porte
 * qu'on n'avait pas regardée.
 *
 * C'est le type de banc le plus facile à écrire de travers : il passe au vert
 * quand la garde fonctionne, ET quand on a testé la mauvaise chose. Chaque
 * contrôle est donc joué DANS LES DEUX SENS — sur un fil chiffré et sur un fil
 * ordinaire. Un contrôle qui refuse tout n'est pas une garde, c'est une panne.
 *
 * Usage : node --env-file=.env scripts/e2ee-nonfuite.mjs
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

async function compte(marque) {
  const email = `nonfuite-${marque}@e2ee.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: await bcrypt.hash(motDePasse, 12), emailVerified: true },
    create: {
      email,
      nom: `NonFuite ${marque}`,
      passwordHash: await bcrypt.hash(motDePasse, 12),
      publicNumber: `NF${marque}${Math.floor(Math.random() * 100000)}`,
      emailVerified: true,
    },
  });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: email,
      password: motDePasse,
      deviceId: `nonfuite-${marque}`,
      typeDevice: 0,
    }),
  });
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`);
  const { accessToken } = await r.json();
  return { user, jeton: accessToken };
}

async function main() {
  console.log("\n\x1b[1m════ BANC DE NON-FUITE ════\x1b[0m");

  const a = await compte("alice");
  const b = await compte("bob");

  let conv = await prisma.conversation.findFirst({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId: a.user.id } } },
        { participants: { some: { userId: b.user.id } } },
      ],
    },
  });
  if (!conv) {
    conv = await prisma.conversation.create({
      data: {
        isGroup: false,
        participants: { create: [{ userId: a.user.id }, { userId: b.user.id }] },
      },
    });
  }

  const SECRET = "Texte confidentiel qui ne doit jamais sortir";

  /** Demande une traduction au relais, en annonçant (ou non) la conversation. */
  async function traduire(convId) {
    const r = await fetch(`${API}/api/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${a.jeton}`,
      },
      body: JSON.stringify({
        target: "en",
        provider: "azure",
        items: [{ empreinte: "essai", texte: SECRET }],
        ...(convId ? { convId } : {}),
      }),
    });
    return { statut: r.status, corps: await r.text() };
  }

  /* ── ① LE RELAIS REFUSE UN FIL CHIFFRÉ ───────────────────────────── */
  titre("① Le relais de traduction et les fils chiffrés");

  await prisma.conversation.update({
    where: { id: conv.id },
    data: { e2eeActif: true },
  });

  const chiffre = await traduire(conv.id);
  verifie(
    "un fil CHIFFRÉ est refusé",
    chiffre.statut === 403 && chiffre.corps.includes("CONVERSATION_CHIFFREE"),
    `HTTP ${chiffre.statut} ${chiffre.corps.slice(0, 120)}`,
  );

  /*
   * ⚠️ LE CONTRÔLE INVERSE COMPTE AUTANT. Une garde qui refuse TOUT passerait
   * le contrôle ci-dessus sans rien protéger — et casserait la traduction pour
   * tout le monde.
   *
   * ⚠️ ON N'ATTEND PAS UN SUCCÈS : le relais peut très bien répondre « moteur
   * indisponible » faute de clé Azure sur ce poste. Ce qu'on vérifie, c'est
   * qu'il ne refuse pas POUR LA MÊME RAISON.
   */
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { e2eeActif: false },
  });

  const clair = await traduire(conv.id);
  verifie(
    "un fil ORDINAIRE n'est pas refusé pour chiffrement",
    !clair.corps.includes("CONVERSATION_CHIFFREE"),
    `HTTP ${clair.statut} ${clair.corps.slice(0, 120)}`,
  );

  const sansConv = await traduire(null);
  verifie(
    "une traduction HORS conversation reste possible",
    !sansConv.corps.includes("CONVERSATION_CHIFFREE"),
    `HTTP ${sansConv.statut} ${sansConv.corps.slice(0, 120)}`,
  );

  /*
   * ⚠️ ON NE PEUT PAS TRADUIRE LA CONVERSATION D'UN AUTRE. La garde lit le fil
   * `where: { id, participants: { some: { userId } } }` — un inconnu n'y trouve
   * rien, et ne peut donc pas s'en servir pour DEVINER si un fil est chiffré.
   */
  const etrangere = await prisma.conversation.create({
    data: { isGroup: false, e2eeActif: true, participants: { create: [] } },
  });
  const oracle = await traduire(etrangere.id);
  verifie(
    "un fil dont on n'est PAS membre ne révèle pas son état",
    !oracle.corps.includes("CONVERSATION_CHIFFREE"),
    "le relais dit « chiffré » pour un fil étranger — c'est un oracle",
  );
  await prisma.conversation.delete({ where: { id: etrangere.id } });

  /* ── ② LE SERVEUR N'A JAMAIS LE TEXTE ────────────────────────────── */
  titre("② Ce que le serveur peut lire d'un message chiffré");

  await prisma.conversation.update({
    where: { id: conv.id },
    data: { e2eeActif: true },
  });

  const cree = await fetch(
    `${API}/api/conversations/${conv.id}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${a.jeton}`,
      },
      body: JSON.stringify({ type: "TEXT", chiffre: true }),
    },
  );
  verifie("la ligne du fil se crée sans contenu", cree.status === 201, `HTTP ${cree.status}`);
  const ligne = cree.ok ? await cree.json() : null;

  if (ligne?.id) {
    const enBase = await prisma.message.findUnique({
      where: { id: ligne.id },
      select: { content: true },
    });
    verifie(
      "`message.content` est vide en base",
      !enBase?.content,
      `content = ${JSON.stringify(enBase?.content)}`,
    );

    const fil = await prisma.conversation.findUnique({
      where: { id: conv.id },
      select: { lastMessage: true },
    });
    verifie(
      "l'aperçu de conversation ne porte aucun texte",
      !fil?.lastMessage,
      `lastMessage = ${JSON.stringify(fil?.lastMessage)}`,
    );

    await prisma.message.delete({ where: { id: ligne.id } });
  }

  /* ── ③ LE CLAIR EST REFUSÉ DES DEUX CÔTÉS ────────────────────────── */
  titre("③ Le texte en clair sur un fil chiffré");

  const enClair = await fetch(
    `${API}/api/conversations/${conv.id}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${a.jeton}`,
      },
      body: JSON.stringify({ type: "TEXT", content: SECRET }),
    },
  );
  const corpsClair = await enClair.text();
  verifie(
    "REST refuse le clair",
    !enClair.ok && corpsClair.includes("CONVERSATION_CHIFFREE"),
    `HTTP ${enClair.status} ${corpsClair.slice(0, 120)}`,
  );

  const restes = await prisma.message.count({
    where: { convId: conv.id, content: { contains: "confidentiel" } },
  });
  verifie("et rien n'a été écrit au passage", restes === 0, `${restes} message(s) en clair`);

  /* ── NETTOYAGE ───────────────────────────────────────────────────── */
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { e2eeActif: false },
  });

  console.log(
    `\n\x1b[1m════ ${echecs === 0 ? "\x1b[32mAUCUNE FUITE" : `\x1b[31m${echecs} FUITE(S)`}\x1b[0m\x1b[1m ════\x1b[0m\n`,
  );
  await prisma.$disconnect();
  process.exit(echecs === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("\n\x1b[31m💥 Le banc s'est arrêté :\x1b[0m", e.message);
  await prisma.$disconnect();
  process.exit(1);
});
