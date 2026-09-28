/**
 * « DISTRIBUÉ » POUR UN MESSAGE CHIFFRÉ, CONTRE LE VRAI SERVEUR.
 *
 * 🐛 Un message chiffré ne passait jamais à « distribué » (user, 28/09/2026) :
 * il restait « envoyé » jusqu'à la lecture. Depuis, l'acquittement d'une
 * enveloppe par un appareil du destinataire le fait passer.
 *
 * Ce banc éprouve la route `DELETE /api/e2ee/enveloppes` — pas la
 * cryptographie : les enveloppes sont écrites directement en base.
 *
 * Usage : node --env-file=.env scripts/e2ee-distribue-banc.mjs
 * (serveur local sur :3000, base locale)
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

/** Même prudence que `e2ee-archive-banc.mjs` : la connexion est limitée à 5/min. */
async function connexion(corps) {
  for (let essai = 1; essai <= 6; essai++) {
    const r = await fetch(`${API}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(corps),
    });
    if (r.ok) return (await r.json()).accessToken;
    if (r.status !== 429) throw new Error(`login → ${r.status} ${await r.text()}`);
    await new Promise((ok) => setTimeout(ok, 12_000));
  }
  throw new Error("login toujours limité");
}

async function compte(marque) {
  const email = `distribue-${marque}@e2ee.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: await bcrypt.hash(motDePasse, 12), emailVerified: true },
    create: {
      email,
      nom: `Distribué ${marque}`,
      passwordHash: await bcrypt.hash(motDePasse, 12),
      publicNumber: `DI${marque}${Math.floor(Math.random() * 100000)}`,
      emailVerified: true,
    },
  });
  const jeton = await connexion({
    identifier: email,
    password: motDePasse,
    deviceId: `distribue-${marque}`,
    typeDevice: 0,
  });
  return { user, jeton };
}

async function acquitter(jeton, ids) {
  const r = await fetch(`${API}/api/e2ee/enveloppes?ids=${ids.join(",")}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${jeton}` },
  });
  return { statut: r.status, json: await r.json().catch(() => null) };
}

async function main() {
  console.log("\n\x1b[1m════ « DISTRIBUÉ » POUR UN MESSAGE CHIFFRÉ ════\x1b[0m");
  const a = await compte("alice");
  const b = await compte("bob");

  const conv = await prisma.conversation.create({
    data: {
      isGroup: false,
      participants: { create: [{ userId: a.user.id }, { userId: b.user.id }] },
    },
  });

  const message = (senderId, status = "SENT") =>
    prisma.message.create({ data: { convId: conv.id, senderId, type: "TEXT", status } });
  const enveloppe = (messageId, expediteurId, destinataireId) =>
    prisma.e2eeEnveloppe.create({
      data: {
        convId: conv.id,
        expediteurId,
        expediteurDevice: 1,
        destinataireId,
        destinataireDevice: 2,
        type: 1,
        corps: "AAAA",
        messageId,
      },
    });

  try {
    console.log("\n① Bob acquitte le message d'Alice");
    const m1 = await message(a.user.id);
    const e1 = await enveloppe(m1.id, a.user.id, b.user.id);
    const r1 = await acquitter(b.jeton, [e1.id]);
    verifie("la route répond 200", r1.statut === 200, JSON.stringify(r1));
    const apres1 = await prisma.message.findUnique({ where: { id: m1.id } });
    verifie("le message passe « distribué »", apres1.status === "DELIVERED", apres1.status);

    console.log("\n② Un message déjà « lu » ne redescend pas");
    const m2 = await message(a.user.id, "READ");
    const e2 = await enveloppe(m2.id, a.user.id, b.user.id);
    await acquitter(b.jeton, [e2.id]);
    const apres2 = await prisma.message.findUnique({ where: { id: m2.id } });
    verifie("il reste « lu »", apres2.status === "READ", apres2.status);

    console.log("\n③ La copie vers mon autre appareil ne compte pas");
    const m3 = await message(b.user.id);
    const e3 = await enveloppe(m3.id, b.user.id, b.user.id);
    await acquitter(b.jeton, [e3.id]);
    const apres3 = await prisma.message.findUnique({ where: { id: m3.id } });
    verifie("mon propre message reste « envoyé »", apres3.status === "SENT", apres3.status);

    console.log("\n④ Personne n'acquitte l'enveloppe d'un autre");
    const m4 = await message(a.user.id);
    const e4 = await enveloppe(m4.id, a.user.id, b.user.id);
    await acquitter(a.jeton, [e4.id]);
    const apres4 = await prisma.message.findUnique({ where: { id: m4.id } });
    verifie("Alice ne peut pas faire passer son propre message", apres4.status === "SENT", apres4.status);
  } finally {
    await prisma.conversation.delete({ where: { id: conv.id } });
  }

  console.log(echecs === 0 ? "\n\x1b[32mTout passe.\x1b[0m\n" : `\n\x1b[31m${echecs} échec(s).\x1b[0m\n`);
  await prisma.$disconnect();
  process.exit(echecs === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
