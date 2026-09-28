/**
 * LE DÉPÔT D'ENVELOPPES RESPECTE LES MÊMES RÈGLES QU'UN MESSAGE ORDINAIRE.
 *
 * 🔴 CE QU'IL CHERCHE. `POST /api/e2ee/enveloppes` vérifiait l'appartenance à
 * la conversation, et rien d'autre. Or c'est lui qui SONNE et NOTIFIE le
 * destinataire. Une personne bloquée pouvait donc, par cette porte, faire
 * sonner et notifier en boucle celui qui l'avait bloquée ; et dans un fil NON
 * chiffré, une enveloppe rattachée à un message en clair faisait afficher un
 * cadenas mensonger.
 *
 *   ① témoin : un dépôt légitime dans un fil chiffré passe ;
 *   ② un fil NON chiffré refuse le dépôt ;
 *   ③ un blocage, dans un sens comme dans l'autre, refuse le dépôt ;
 *   ④ sans ligne de message, rien n'est notifié (pas de sonnette dans le vide) ;
 *   ⑤ « supprimer pour tous » retire aussi les enveloppes pas encore relevées.
 *
 * ⚠️ LA SOURDINE N'EST PAS ÉPROUVÉE ICI : l'envoi push est inerte en local, on
 * ne peut pas compter les notifications. Elle est prouvée par lecture — le
 * dépôt lit désormais `participant.sourdine`, comme le WebSocket.
 *
 * Usage : node --env-file=.env scripts/e2ee-depot-banc.mjs
 *         (backend :3000 et WebSocket :3001 démarrés)
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import WebSocket from "ws";

const API = process.env.API_URL ?? "http://localhost:3000";
const WS = process.env.WS_URL ?? "ws://localhost:3001";
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
  const email = `depot-${marque}@e2ee.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const hash = await bcrypt.hash(motDePasse, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Depot ${marque}`,
      passwordHash: hash,
      publicNumber: `DP${Math.floor(Math.random() * 1000000)}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
  await prisma.blocked.deleteMany({
    where: { OR: [{ alanyaID: user.id }, { idCallerBlock: user.id }] },
  });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `depot-${marque}`, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`);
  return { user, jeton: (await r.json()).accessToken };
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

/** La ligne du fil qu'un message chiffré crée avant ses enveloppes. */
function ligne(convId, auteur, content = null) {
  return prisma.message.create({
    data: { convId, senderId: auteur.user.id, content, type: "TEXT", status: "SENT" },
    select: { id: true },
  });
}

async function deposer(qui, convId, pour, messageId) {
  const r = await fetch(`${API}/api/e2ee/enveloppes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${qui.jeton}` },
    body: JSON.stringify({
      convId,
      deviceId: 1,
      messageId,
      enveloppes: [{ destinataireId: pour.user.id, destinataireDevice: 1, type: 1, corps: "QUJDRA==" }],
    }),
  });
  return { statut: r.status, texte: await r.text() };
}

function enveloppesPour(qui, convId) {
  return prisma.e2eeEnveloppe.count({ where: { destinataireId: qui.user.id, convId } });
}

/** Une connexion WebSocket prête, qui garde tout ce qu'elle reçoit. */
function connecter(qui) {
  return new Promise((resoudre, rejeter) => {
    const ws = new WebSocket(`${WS}?token=${qui.jeton}`);
    const recus = [];
    ws.on("message", (b) => {
      try {
        const m = JSON.parse(String(b));
        recus.push(m);
        if (m.type === "ready") resoudre({ ws, recus });
      } catch {}
    });
    ws.on("error", rejeter);
    setTimeout(() => rejeter(new Error("WebSocket : pas de « ready » en 10 s")), 10000);
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\n\x1b[1m════ LE DÉPÔT D'ENVELOPPES ET SES GARDES ════\x1b[0m");

  const alice = await compte("alice");
  const bob = await compte("bob");
  const carole = await compte("carole");
  const filChiffre = await filEntre(alice, bob, true);
  const filClair = await filEntre(alice, carole, false);
  await prisma.e2eeEnveloppe.deleteMany({ where: { convId: { in: [filChiffre, filClair] } } });

  const B = await connecter(bob);

  titre("① Témoin : un dépôt légitime dans un fil chiffré");
  const m1 = await ligne(filChiffre, alice);
  const r1 = await deposer(alice, filChiffre, bob, m1.id);
  verifie("accepté", r1.statut === 201, `HTTP ${r1.statut} ${r1.texte.slice(0, 120)}`);
  await pause(600);
  verifie(
    "et Bob est sonné",
    B.recus.some((m) => m.type === "e2ee_arrivee" && m.convId === filChiffre),
    JSON.stringify(B.recus.slice(-3)).slice(0, 200),
  );

  titre("② Un fil NON chiffré refuse le dépôt");
  const clair = await ligne(filClair, alice, "bonjour en clair");
  const avantClair = await enveloppesPour(carole, filClair);
  const r2 = await deposer(alice, filClair, carole, clair.id);
  verifie(
    "refusé, et rien n'est déposé",
    r2.statut >= 400 && (await enveloppesPour(carole, filClair)) === avantClair,
    `HTTP ${r2.statut} — une enveloppe sur un message en clair lui donne un faux cadenas`,
  );

  titre("③ Un blocage refuse le dépôt, dans les deux sens");
  for (const [libelle, bloqueur, bloque] of [
    ["Bob a bloqué Alice", bob, alice],
    ["Alice a bloqué Bob", alice, bob],
  ]) {
    await prisma.blocked.create({ data: { alanyaID: bloqueur.user.id, idCallerBlock: bloque.user.id } });
    const m = await ligne(filChiffre, alice);
    const avant = await enveloppesPour(bob, filChiffre);
    const sonneries = B.recus.length;
    const r = await deposer(alice, filChiffre, bob, m.id);
    await pause(600);
    verifie(
      `${libelle} : refusé, rien de déposé, rien de sonné`,
      r.statut >= 400 &&
        (await enveloppesPour(bob, filChiffre)) === avant &&
        !B.recus.slice(sonneries).some((x) => x.type === "e2ee_arrivee"),
      `HTTP ${r.statut}`,
    );
    await prisma.blocked.deleteMany({ where: { alanyaID: bloqueur.user.id } });
  }

  titre("④ Sans ligne de message, personne n'est sonné");
  /*
   * Un dépôt sans \`messageId\` reste permis (bancs, futur échange de clés hors
   * fil) : mais il n'y a alors aucun message à annoncer, et sonner ou notifier
   * pour rien, c'est ce qui rendait le harcèlement possible.
   */
  const avantSonnerie = B.recus.length;
  const r4 = await deposer(alice, filChiffre, bob, undefined);
  await pause(600);
  verifie(
    "déposé, mais pas de sonnette",
    r4.statut === 201 && !B.recus.slice(avantSonnerie).some((x) => x.type === "e2ee_arrivee"),
    `HTTP ${r4.statut}`,
  );

  titre("⑤ « Supprimer pour tous » retire les enveloppes en attente");
  /*
   * 🐛 LE SERVEUR VIDAIT `content`… qu'un message chiffré n'a pas. Ses
   * enveloppes, elles, restaient servies : un destinataire hors ligne relevait
   * et déchiffrait plus tard un message que l'auteur avait supprimé pour tous.
   */
  const A = await connecter(alice);
  for (const [chemin, supprimer] of [
    [
      "REST",
      (id) =>
        fetch(`${API}/api/conversations/${filChiffre}/messages/${id}?scope=everyone`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${alice.jeton}` },
        }),
    ],
    ["WebSocket", async (id) => A.ws.send(JSON.stringify({ type: "delete_message", messageId: id, scope: "everyone" }))],
  ]) {
    const m = await ligne(filChiffre, alice);
    await deposer(alice, filChiffre, bob, m.id);
    const avant = await prisma.e2eeEnveloppe.count({ where: { messageId: m.id } });
    await supprimer(m.id);
    await pause(800);
    const apres = await prisma.e2eeEnveloppe.count({ where: { messageId: m.id } });
    const supprime = (await prisma.message.findUnique({ where: { id: m.id }, select: { deletedAt: true } }))?.deletedAt;
    verifie(
      `${chemin} : le message est supprimé, et son enveloppe ne se relève plus`,
      avant === 1 && supprime != null && apres === 0,
      `${avant} enveloppe(s) avant, ${apres} après, supprimé : ${supprime != null}`,
    );
  }
  A.ws.close();

  B.ws.close();
  await prisma.e2eeEnveloppe.deleteMany({ where: { convId: { in: [filChiffre, filClair] } } });
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
