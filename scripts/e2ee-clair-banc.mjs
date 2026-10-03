/**
 * LE BANC DES PORTES LATÉRALES — modifier et transférer, dans un fil chiffré.
 *
 * 🔴 CE QU'IL CHERCHE : un chemin par lequel du TEXTE EN CLAIR s'écrit dans un
 * fil chiffré, ou par lequel un message sort d'une conversation où l'on n'est
 * pas. L'envoi était gardé depuis le 22/09 ; ces quatre-là ne l'étaient pas.
 *
 *   ① modifier un message — REST (PATCH) et WebSocket (`edit_message`) ;
 *   ② transférer — REST et WebSocket, dans les deux sens :
 *        · d'un fil chiffré (le serveur n'a pas le texte : bulle vide) ;
 *        · VERS un fil chiffré (du clair y entrerait sans chiffrement) ;
 *   ③ transférer un message d'une conversation dont on n'est PAS membre ;
 *   ④ RÉPONDRE en citant un message d'une conversation dont on n'est pas
 *     membre — REST, WebSocket, et la lecture d'une citation déjà en base ;
 *   ⑤ un MÉDIA EN CLAIR dans un fil chiffré — envoi REST et WebSocket,
 *     transfert REST et WebSocket (lot D, chapitre 26).
 *
 * ⚠️ CHAQUE REFUS A SON TÉMOIN : le même geste sur un fil ORDINAIRE doit
 * passer. Une garde qui refuse tout passerait les refus sans rien protéger.
 *
 * Usage : node --env-file=.env scripts/e2ee-clair-banc.mjs
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
  const email = `clair-${marque}@e2ee.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const hash = await bcrypt.hash(motDePasse, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Clair ${marque}`,
      passwordHash: hash,
      publicNumber: `CL${Math.floor(Math.random() * 1000000)}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `clair-${marque}`, typeDevice: 0 }),
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

/** Un message tel que le serveur le range : texte en clair, ou vide s'il est chiffré. */
function message(convId, auteur, content) {
  return prisma.message.create({
    data: { convId, senderId: auteur.user.id, content, type: "TEXT", status: "SENT" },
    select: { id: true },
  });
}

async function rest(qui, methode, chemin, corps) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${qui.jeton}` },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  return { statut: r.status, texte: await r.text() };
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

async function contenu(id) {
  return (await prisma.message.findUnique({ where: { id }, select: { content: true } }))?.content;
}

/** Combien de messages dans ce fil ? Un transfert refusé n'en ajoute aucun. */
function compter(convId) {
  return prisma.message.count({ where: { convId } });
}

async function main() {
  console.log("\n\x1b[1m════ LES PORTES LATÉRALES DU CLAIR ════\x1b[0m");

  const alice = await compte("alice");
  const bob = await compte("bob");
  const carole = await compte("carole");

  const filChiffre = await filEntre(alice, bob, true);
  const filClair = await filEntre(alice, carole, false);
  const filCaroleBob = await filEntre(carole, bob, false);

  const A = await connecter(alice);
  const B = await connecter(bob);

  /* ── ① MODIFIER ──────────────────────────────────────────────────── */
  titre("① Modifier un message");

  const aModifierRest = await message(filChiffre, alice, null);
  const r1 = await rest(alice, "PATCH", `/api/conversations/${filChiffre}/messages/${aModifierRest.id}`, {
    content: "SECRET-REST",
  });
  verifie("REST, fil chiffré : refusé", r1.statut === 409 && r1.texte.includes("CONVERSATION_CHIFFREE"), `HTTP ${r1.statut} ${r1.texte.slice(0, 120)}`);
  verifie("REST, fil chiffré : rien d'écrit", (await contenu(aModifierRest.id)) === null, `contenu = ${await contenu(aModifierRest.id)}`);

  const temoinRest = await message(filClair, alice, "avant");
  const r2 = await rest(alice, "PATCH", `/api/conversations/${filClair}/messages/${temoinRest.id}`, { content: "après" });
  verifie("REST, fil ordinaire : accepté (témoin)", r2.statut === 200 && (await contenu(temoinRest.id)) === "après", `HTTP ${r2.statut}`);

  const aModifierWs = await message(filChiffre, alice, null);
  B.recus.length = 0;
  A.ws.send(JSON.stringify({ type: "edit_message", messageId: aModifierWs.id, content: "SECRET-WS" }));
  await pause(800);
  verifie("WebSocket, fil chiffré : rien d'écrit", (await contenu(aModifierWs.id)) === null, `contenu = ${await contenu(aModifierWs.id)}`);
  verifie(
    "WebSocket, fil chiffré : le correspondant ne reçoit PAS le texte",
    !B.recus.some((m) => JSON.stringify(m).includes("SECRET-WS")),
    "le clair a été diffusé à Bob",
  );
  verifie(
    "WebSocket, fil chiffré : l'auteur est prévenu",
    A.recus.some((m) => m.type === "error" && m.code === "CONVERSATION_CHIFFREE"),
    "refus muet : l'écran de l'auteur croit la modification faite",
  );

  const temoinWs = await message(filClair, alice, "avant");
  A.ws.send(JSON.stringify({ type: "edit_message", messageId: temoinWs.id, content: "après-ws" }));
  await pause(800);
  verifie("WebSocket, fil ordinaire : accepté (témoin)", (await contenu(temoinWs.id)) === "après-ws");

  /* ── ② TRANSFÉRER ────────────────────────────────────────────────── */
  titre("② Transférer");

  // D'un fil chiffré : le serveur n'a pas le texte, il fabriquerait une bulle vide.
  const chiffre = await message(filChiffre, alice, null);
  let avant = await compter(filClair);
  const r3 = await rest(alice, "POST", `/api/conversations/${filChiffre}/messages/forward`, {
    messageId: chiffre.id,
    targetConvIds: [filClair],
  });
  verifie(
    "REST, depuis un fil chiffré : aucune bulle vide créée",
    (await compter(filClair)) === avant,
    `HTTP ${r3.statut} — ${(await compter(filClair)) - avant} message(s) créé(s)`,
  );

  // VERS un fil chiffré : du clair y entrerait sans avoir été chiffré.
  const clair = await message(filClair, alice, "CLAIR-VERS-CHIFFRE");
  avant = await compter(filChiffre);
  const r4 = await rest(alice, "POST", `/api/conversations/${filClair}/messages/forward`, {
    messageId: clair.id,
    targetConvIds: [filChiffre],
  });
  verifie(
    "REST, vers un fil chiffré : refusé",
    (await compter(filChiffre)) === avant,
    `HTTP ${r4.statut} — le texte est entré en clair dans le fil chiffré`,
  );

  avant = await compter(filChiffre);
  A.recus.length = 0;
  A.ws.send(JSON.stringify({ type: "forward_message", messageId: clair.id, targetConvIds: [filChiffre] }));
  await pause(800);
  verifie("WebSocket, vers un fil chiffré : refusé", (await compter(filChiffre)) === avant);

  avant = await compter(filClair);
  A.ws.send(JSON.stringify({ type: "forward_message", messageId: chiffre.id, targetConvIds: [filClair] }));
  await pause(800);
  verifie("WebSocket, depuis un fil chiffré : aucune bulle vide créée", (await compter(filClair)) === avant);
  verifie(
    "WebSocket : l'auteur est prévenu des refus",
    A.recus.some((m) => m.type === "error" && m.code === "CONVERSATION_CHIFFREE"),
  );

  // Témoin : un fil ordinaire vers un autre fil ordinaire, sans rien de chiffré.
  const ordinaire = await message(filClair, alice, "ordinaire");
  const filAliceBob2 = filClair; // Alice est membre de la cible
  avant = await compter(filAliceBob2);
  const r5 = await rest(alice, "POST", `/api/conversations/${filClair}/messages/forward`, {
    messageId: ordinaire.id,
    targetConvIds: [filAliceBob2],
  });
  verifie("REST, fil ordinaire → fil ordinaire : accepté (témoin)", r5.statut === 201 && (await compter(filAliceBob2)) === avant + 1, `HTTP ${r5.statut}`);

  /* ── ③ UN MESSAGE D'UNE CONVERSATION ÉTRANGÈRE ───────────────────── */
  titre("③ Transférer un message d'une conversation dont on n'est pas membre");

  // Un message d'Alice à Carole. Bob n'en est pas membre, mais il est membre
  // du fil qu'il met dans l'adresse — c'est tout ce que la route vérifiait.
  const prive = await message(filClair, alice, "PRIVÉ-ALICE-CAROLE");
  avant = await compter(filCaroleBob);
  const r6 = await rest(bob, "POST", `/api/conversations/${filCaroleBob}/messages/forward`, {
    messageId: prive.id,
    targetConvIds: [filCaroleBob],
  });
  const fuite = await prisma.message.findFirst({
    where: { convId: filCaroleBob, content: "PRIVÉ-ALICE-CAROLE" },
    select: { id: true },
  });
  verifie(
    "REST : refusé, et rien n'est copié",
    fuite === null && (await compter(filCaroleBob)) === avant,
    `HTTP ${r6.statut} — Bob a copié un message d'une conversation où il n'est pas`,
  );

  /* ── ④ CITER UN MESSAGE D'UNE CONVERSATION ÉTRANGÈRE ─────────────── */
  titre("④ Répondre en citant un message d'une conversation dont on n'est pas membre");
  /*
   * 🐛 `replyToId` N'ÉTAIT JAMAIS VÉRIFIÉ, et la citation se résolvait par le
   * seul identifiant : Bob, dans SON fil, citait un message d'Alice à Carole,
   * et le serveur lui renvoyait le texte cité. Même famille que ③, autre porte.
   */
  const fuiteDans = (texte) => texte.includes("PRIVÉ-ALICE-CAROLE");
  const r7 = await rest(bob, "POST", `/api/conversations/${filCaroleBob}/messages`, {
    content: "je réponds",
    type: "TEXT",
    replyToId: prive.id,
  });
  const citeRest = await prisma.message.count({ where: { convId: filCaroleBob, replyToId: prive.id } });
  verifie(
    "REST : refusé, et le texte cité ne revient pas",
    r7.statut >= 400 && citeRest === 0 && !fuiteDans(r7.texte),
    `HTTP ${r7.statut}, ${citeRest} ligne(s) — ${r7.texte.slice(0, 160)}`,
  );

  const avantWs = B.recus.length;
  B.ws.send(JSON.stringify({ type: "send", convId: filCaroleBob, content: "je réponds ws", tempId: "t-reply-ws", replyToId: prive.id }));
  await pause(1200);
  const recusWs = JSON.stringify(B.recus.slice(avantWs));
  const citeWs = await prisma.message.count({ where: { convId: filCaroleBob, replyToId: prive.id } });
  verifie(
    "WebSocket : refusé, et le texte cité ne revient pas",
    citeWs === 0 && !fuiteDans(recusWs),
    `${citeWs} ligne(s) — ${recusWs.slice(0, 200)}`,
  );

  // Une citation étrangère DÉJÀ en base (écrite avant le correctif) ne doit
  // pas se lire non plus.
  await prisma.message.create({
    data: { convId: filCaroleBob, senderId: bob.user.id, content: "ancienne", type: "TEXT", status: "SENT", replyToId: prive.id },
  });
  const r8 = await rest(bob, "GET", `/api/conversations/${filCaroleBob}/messages`);
  verifie("lecture REST : une citation étrangère en base ne rend pas son texte", !fuiteDans(r8.texte), r8.texte.slice(0, 160));
  await prisma.message.deleteMany({ where: { convId: filCaroleBob, replyToId: prive.id } });

  // Témoin : citer un message du MÊME fil passe.
  const local = await message(filCaroleBob, carole, "TEXTE-DU-FIL");
  const r9 = await rest(bob, "POST", `/api/conversations/${filCaroleBob}/messages`, {
    content: "je réponds au fil",
    type: "TEXT",
    replyToId: local.id,
  });
  // ⚠️ La réponse de création ne porte pas la citation : on relit le fil.
  const r10 = await rest(bob, "GET", `/api/conversations/${filCaroleBob}/messages`);
  verifie(
    "témoin : citer un message du même fil passe, et la citation se lit",
    r9.statut === 201 && r10.texte.includes("TEXTE-DU-FIL") && r10.texte.includes(`"replyTo":{"id":"${local.id}"`),
    `HTTP ${r9.statut}`,
  );

  /* ── ⑤ LES MÉDIAS EN CLAIR (lot D) ─────────────────────────────────── */
  titre("⑤ Un média en clair dans un fil chiffré");

  /** Un fichier téléversé par `qui` : en clair, ou marqué chiffré. */
  const fichier = (qui, chiffreFichier) =>
    prisma.mediaFile.create({
      data: {
        ownerId: qui.user.id,
        filename: chiffreFichier ? "chiffre.bin" : "photo.jpg",
        mimeType: chiffreFichier ? "application/octet-stream" : "image/jpeg",
        sizeBytes: 1234,
        url: `/banc/${Date.now()}-${Math.random()}`,
        chiffre: chiffreFichier,
      },
      select: { id: true },
    });
  const rattache = async (id) =>
    (await prisma.mediaFile.findUnique({ where: { id }, select: { messageId: true } }))?.messageId ?? null;

  // Envoi WebSocket.
  const clairWs = await fichier(alice, false);
  A.recus.length = 0;
  A.ws.send(JSON.stringify({ type: "send", convId: filChiffre, msgType: "IMAGE", mediaIds: [clairWs.id], tempId: "t-media-clair" }));
  await pause(1000);
  verifie("WebSocket, fil chiffré : le fichier en clair n'est rattaché à rien", (await rattache(clairWs.id)) === null);
  verifie(
    "WebSocket, fil chiffré : l'auteur est prévenu, avec son tempId",
    A.recus.some((m) => m.type === "error" && m.code === "CONVERSATION_CHIFFREE" && m.tempId === "t-media-clair"),
    JSON.stringify(A.recus.filter((m) => m.type === "error")).slice(0, 200),
  );

  const chiffreWs = await fichier(alice, true);
  A.ws.send(JSON.stringify({ type: "send", convId: filChiffre, msgType: "IMAGE", mediaIds: [chiffreWs.id], tempId: "t-media-chiffre" }));
  await pause(1000);
  verifie("WebSocket, fil chiffré : un fichier CHIFFRÉ passe (témoin)", (await rattache(chiffreWs.id)) !== null);

  const clairWsTemoin = await fichier(alice, false);
  A.ws.send(JSON.stringify({ type: "send", convId: filClair, msgType: "IMAGE", mediaIds: [clairWsTemoin.id], tempId: "t-media-ordinaire" }));
  await pause(1000);
  verifie("WebSocket, fil ordinaire : un fichier en clair passe (témoin)", (await rattache(clairWsTemoin.id)) !== null);

  // Envoi REST, par le chemin chiffré lui-même.
  const clairRest = await fichier(alice, false);
  const r11 = await rest(alice, "POST", `/api/conversations/${filChiffre}/messages`, {
    type: "IMAGE",
    chiffre: true,
    mediaIds: [clairRest.id],
  });
  verifie(
    "REST chiffré, fil chiffré : un fichier en clair est refusé",
    r11.statut === 409 && r11.texte.includes("CONVERSATION_CHIFFREE") && (await rattache(clairRest.id)) === null,
    `HTTP ${r11.statut} ${r11.texte.slice(0, 120)}`,
  );
  const chiffreRest = await fichier(alice, true);
  const r12 = await rest(alice, "POST", `/api/conversations/${filChiffre}/messages`, {
    type: "IMAGE",
    chiffre: true,
    mediaIds: [chiffreRest.id],
  });
  verifie("REST chiffré, fil chiffré : un fichier chiffré passe (témoin)", r12.statut === 201, `HTTP ${r12.statut} ${r12.texte.slice(0, 120)}`);

  // Transfert d'une photo en clair VERS le fil chiffré.
  const photo = await prisma.message.create({
    data: {
      convId: filClair,
      senderId: alice.user.id,
      content: null,
      type: "IMAGE",
      status: "SENT",
      media: { connect: [{ id: (await fichier(alice, false)).id }] },
    },
    select: { id: true },
  });
  avant = await compter(filChiffre);
  const r13 = await rest(alice, "POST", `/api/conversations/${filClair}/messages/forward`, {
    messageId: photo.id,
    targetConvIds: [filChiffre],
  });
  verifie(
    "REST : une photo en clair ne se transfère pas vers un fil chiffré",
    r13.statut === 409 && (await compter(filChiffre)) === avant,
    `HTTP ${r13.statut} — ${(await compter(filChiffre)) - avant} message(s) créé(s)`,
  );
  A.ws.send(JSON.stringify({ type: "forward_message", messageId: photo.id, targetConvIds: [filChiffre] }));
  await pause(1000);
  verifie("WebSocket : idem", (await compter(filChiffre)) === avant, `${(await compter(filChiffre)) - avant} message(s) créé(s)`);

  avant = await compter(filClair);
  const r14 = await rest(alice, "POST", `/api/conversations/${filClair}/messages/forward`, {
    messageId: photo.id,
    targetConvIds: [filClair],
  });
  verifie("témoin : la même photo se transfère vers un fil ordinaire", r14.statut === 201 && (await compter(filClair)) === avant + 1, `HTTP ${r14.statut} ${r14.texte.slice(0, 160)}`);

  // Un média CHIFFRÉ ne se transfère pas par le serveur, qui n'a pas sa clé.
  const photoChiffree = await prisma.message.create({
    data: {
      convId: filChiffre,
      senderId: alice.user.id,
      content: null,
      type: "IMAGE",
      status: "SENT",
      media: { connect: [{ id: (await fichier(alice, true)).id }] },
    },
    select: { id: true },
  });
  avant = await compter(filClair);
  const r15 = await rest(alice, "POST", `/api/conversations/${filChiffre}/messages/forward`, {
    messageId: photoChiffree.id,
    targetConvIds: [filClair],
  });
  verifie(
    "REST : un média chiffré ne se transfère pas par le serveur",
    r15.statut === 409 && r15.texte.includes("SOURCE_CHIFFREE") && (await compter(filClair)) === avant,
    `HTTP ${r15.statut} ${r15.texte.slice(0, 120)}`,
  );

  A.ws.close();
  B.ws.close();
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
