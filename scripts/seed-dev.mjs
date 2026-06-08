// Script de seed DEV : utilisateurs, contacts, discussions et groupe de test.
// Usage : node --env-file=.env scripts/seed-dev.mjs
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const prisma = new PrismaClient();

function sixDigits() {
  return crypto.randomInt(100_000, 1_000_000).toString();
}

async function ensureUser(email, pseudo, password) {
  const existing = await prisma.user.findUnique({ where: { email }, include: { profile: true } });
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(password, 12);
  let publicNumber = sixDigits();
  while (await prisma.user.findUnique({ where: { publicNumber } })) {
    publicNumber = sixDigits();
  }

  return prisma.user.create({
    data: {
      email,
      emailVerified: true,
      passwordHash,
      publicNumber,
      profile: { create: { displayName: pseudo } },
    },
    include: { profile: true },
  });
}

async function ensureContact(userId, contactId) {
  await prisma.contact.upsert({
    where: { userId_contactId: { userId, contactId } },
    create: { userId, contactId },
    update: {},
  });
}

async function findDirectConv(a, b) {
  const parts = await prisma.participant.findMany({
    where: { userId: { in: [a, b] } },
    select: { convId: true, userId: true, conv: { select: { isGroup: true } } },
  });
  const byConv = new Map();
  for (const p of parts) {
    if (p.conv.isGroup) continue;
    if (!byConv.has(p.convId)) byConv.set(p.convId, new Set());
    byConv.get(p.convId).add(p.userId);
  }
  for (const [convId, ids] of byConv) {
    if (ids.has(a) && ids.has(b)) return convId;
  }
  return null;
}

async function ensureDirectConv(a, b, starterId, text) {
  let convId = await findDirectConv(a, b);
  if (!convId) {
    const conv = await prisma.conversation.create({
      data: {
        isGroup: false,
        participants: { create: [{ userId: a }, { userId: b }] },
      },
    });
    convId = conv.id;
  }
  const existing = await prisma.message.findFirst({ where: { convId, content: text } });
  if (!existing) {
    await prisma.message.create({
      data: { convId, senderId: starterId, content: text, type: "TEXT", status: "SENT" },
    });
  }
  return convId;
}

async function ensureGroup(name, memberIds, starterId, text) {
  const existing = await prisma.conversation.findFirst({
    where: { isGroup: true, name },
    include: { participants: true },
  });
  if (existing) {
    const ids = new Set(existing.participants.map((p) => p.userId));
    const same =
      memberIds.length === ids.size && memberIds.every((id) => ids.has(id));
    if (same) {
      const msg = await prisma.message.findFirst({
        where: { convId: existing.id, content: text },
      });
      if (!msg) {
        await prisma.message.create({
          data: {
            convId: existing.id,
            senderId: starterId,
            content: text,
            type: "TEXT",
            status: "SENT",
          },
        });
      }
      return existing.id;
    }
  }

  const conv = await prisma.conversation.create({
    data: {
      isGroup: true,
      name,
      participants: {
        create: memberIds.map((id) => ({
          userId: id,
          role: id === starterId ? "ADMIN" : "MEMBER",
        })),
      },
    },
  });
  await prisma.message.create({
    data: { convId: conv.id, senderId: starterId, content: text, type: "TEXT", status: "SENT" },
  });
  return conv.id;
}

async function main() {
  const pwd = "motdepasse123";
  const alice = await ensureUser("alice@example.com", "Alice", pwd);
  const bob = await ensureUser("bob@example.com", "Bob", pwd);
  const charlie = await ensureUser("charlie@example.com", "Charlie", pwd);

  for (const u of [alice, bob, charlie]) {
    console.log(
      `${(u.profile?.displayName ?? "?").padEnd(8)} ${u.email.padEnd(24)} numéro=${u.publicNumber}`,
    );
  }

  // Contacts croisés
  for (const [a, b] of [
    [alice, bob],
    [alice, charlie],
    [bob, charlie],
  ]) {
    await ensureContact(a.id, b.id);
    await ensureContact(b.id, a.id);
  }

  const directId = await ensureDirectConv(
    alice.id,
    bob.id,
    alice.id,
    "Salut Bob ! Discussion de test Alice ↔ Bob.",
  );

  const groupId = await ensureGroup(
    "Équipe Alanya",
    [alice.id, bob.id, charlie.id],
    alice.id,
    "Bienvenue dans le groupe de test — messagerie et appels de groupe.",
  );

  console.log("\nMot de passe commun :", pwd);
  console.log("Discussion Alice↔Bob :", directId);
  console.log("Groupe « Équipe Alanya » :", groupId);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
