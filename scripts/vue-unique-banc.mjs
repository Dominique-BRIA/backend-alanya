/**
 * BANC — MESSAGES À VUE UNIQUE, de bout en bout contre le vrai serveur.
 *
 *   ① envoi : une photo à vue unique part SANS sa légende ; refus d'un texte,
 *     de deux photos, et du réemploi du même média ;
 *   ② avant ouverture : le média est refusé à TOUS, expéditeur compris ;
 *   ③ ouverture : le destinataire reçoit le média, l'expéditeur est refusé,
 *     les deux voient « ouverte » ;
 *   ④ fermeture : le fichier disparaît du DISQUE, la ligne aussi, et une
 *     seconde ouverture est refusée ;
 *   ⑤ purge de secours (option `--purge`) : un visionneur jamais refermé est
 *     effacé passé la fenêtre — à lancer en deux temps, voir plus bas.
 *
 * Usage :
 *   node --env-file=.env scripts/vue-unique-banc.mjs
 *       (serveur Next :3000 démarré, stockage LOCAL)
 *   node --env-file=.env scripts/vue-unique-banc.mjs --preparer-purge
 *       puis redémarrer le serveur, attendre 40 s, et :
 *   node --env-file=.env scripts/vue-unique-banc.mjs --verifier-purge
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const API = process.env.API_URL ?? "http://localhost:3000";
const RACINE = process.env.MEDIA_STORAGE_DIR ?? "./storage/media";
const TEMOIN_PURGE = "./storage/vue-unique-banc-purge.json";
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

async function compte(marque) {
  const email = `vu-${marque}@banc.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const hash = await bcrypt.hash(motDePasse, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Vue ${marque}`,
      passwordHash: hash,
      publicNumber: `8${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `banc-vue-unique-${marque}`, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`);
  return { user, jeton: (await r.json()).accessToken };
}

async function filEntre(a, b) {
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
    data: { isGroup: false, participants: { create: [{ userId: a.user.id }, { userId: b.user.id }] } },
    select: { id: true },
  });
  return c.id;
}

const appel = (qui, chemin, init = {}) =>
  fetch(`${API}${chemin}`, {
    ...init,
    redirect: "manual",
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${qui.jeton}` },
  });

async function televerser(qui) {
  // Un vrai PNG de 1×1 : le serveur vérifie le type déclaré.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "secret.png");
  const r = await appel(qui, "/api/media", { method: "POST", body: form });
  if (!r.ok) throw new Error(`upload → ${r.status} ${await r.text()}`);
  return (await r.json()).id;
}

async function envoyer(qui, convId, corps) {
  const r = await appel(qui, `/api/conversations/${convId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });
  return { statut: r.status, corps: await r.json().catch(() => null) };
}

async function messageVu(qui, convId, id) {
  const r = await appel(qui, `/api/conversations/${convId}/messages`);
  const j = await r.json();
  return (j.messages ?? []).find((m) => m.id === id);
}

const cheminDisque = async (mediaId) => {
  const f = await prisma.mediaFile.findUnique({ where: { id: mediaId }, select: { url: true } });
  return f ? join(RACINE, f.url) : null;
};

const alice = await compte("alice");
const bob = await compte("bob");

// ══════════════ Purge de secours, en deux temps ══════════════
if (process.argv.includes("--preparer-purge")) {
  const convId = await filEntre(alice, bob);
  const mediaId = await televerser(alice);
  const disque = await cheminDisque(mediaId);
  const e = await envoyer(alice, convId, { type: "IMAGE", mediaIds: [mediaId], vueUnique: true });
  await appel(bob, `/api/messages/${e.corps.id}/vue-unique`, { method: "POST" });
  // Le visionneur ne dit JAMAIS qu'il referme ; l'ouverture date de 10 min.
  await prisma.messageOuverture.update({
    where: { messageId_userId: { messageId: e.corps.id, userId: bob.user.id } },
    data: { ouvertA: new Date(Date.now() - 10 * 60 * 1000) },
  });
  writeFileSync(TEMOIN_PURGE, JSON.stringify({ messageId: e.corps.id, mediaId, disque }));
  console.log("Préparé. Redémarrer le serveur, attendre 40 s, puis --verifier-purge.");
  console.log(`  fichier présent : ${existsSync(disque)}`);
  await prisma.$disconnect();
  process.exit(0);
}
if (process.argv.includes("--verifier-purge")) {
  const { messageId, mediaId, disque } = JSON.parse(readFileSync(TEMOIN_PURGE, "utf8"));
  titre("⑤ purge de secours : visionneur jamais refermé");
  verifie("le fichier a quitté le disque", !existsSync(disque), disque);
  verifie("la ligne media_files a disparu", (await prisma.mediaFile.count({ where: { id: mediaId } })) === 0);
  verifie(
    "le message reste, marqué vue unique",
    (await prisma.message.findUnique({ where: { id: messageId } }))?.vueUnique === true,
  );
  await prisma.$disconnect();
  process.exit(echecs ? 1 : 0);
}

// ══════════════ ① Envoi ══════════════
titre("① envoi");
const convId = await filEntre(alice, bob);
const mediaId = await televerser(alice);
const disque = await cheminDisque(mediaId);
verifie("le fichier est sur le disque", disque !== null && existsSync(disque), disque);

const texte = await envoyer(alice, convId, { type: "TEXT", content: "coucou", vueUnique: true });
verifie("un texte à vue unique est refusé (422)", texte.statut === 422, JSON.stringify(texte));

const second = await televerser(alice);
const deux = await envoyer(alice, convId, { type: "IMAGE", mediaIds: [mediaId, second], vueUnique: true });
verifie("deux photos à vue unique sont refusées (422)", deux.statut === 422, JSON.stringify(deux));

const envoi = await envoyer(alice, convId, {
  type: "IMAGE",
  mediaIds: [mediaId],
  content: "légende qui ne doit pas rester",
  vueUnique: true,
});
verifie("la photo à vue unique part (201)", envoi.statut === 201, JSON.stringify(envoi));
const id = envoi.corps?.id;
verifie("sa légende est retirée", envoi.corps?.content === null, envoi.corps?.content);
verifie("la réponse l'annonce à vue unique", envoi.corps?.vueUnique === true);

const reemploi = await envoyer(alice, convId, { type: "IMAGE", mediaIds: [mediaId] });
verifie("son média ne peut pas repartir dans un autre message (403)", reemploi.statut === 403, JSON.stringify(reemploi));

// ══════════════ ② Avant ouverture ══════════════
titre("② avant ouverture");
verifie("l'expéditeur ne peut pas la voir (403)", (await appel(alice, `/api/media/${mediaId}`)).status === 403);
verifie("le destinataire non plus, tant qu'il n'a pas ouvert (403)", (await appel(bob, `/api/media/${mediaId}`)).status === 403);
const vuParBob = await messageVu(bob, convId, id);
verifie("la liste l'annonce non ouverte au destinataire", vuParBob?.vueUnique === true && vuParBob?.vueUniqueOuverte === false, JSON.stringify(vuParBob));

// ══════════════ ③ Ouverture ══════════════
titre("③ ouverture");
const parAlice = await appel(alice, `/api/messages/${id}/vue-unique`, { method: "POST" });
verifie("l'expéditeur ne peut pas l'ouvrir (403)", parAlice.status === 403);
const ouv = await appel(bob, `/api/messages/${id}/vue-unique`, { method: "POST" });
const ouvJ = await ouv.json();
verifie("le destinataire l'ouvre (200)", ouv.status === 200, JSON.stringify(ouvJ));
verifie("…et reçoit son média", ouvJ.media?.[0]?.id === mediaId);
const lecture = await appel(bob, `/api/media/${mediaId}`);
verifie("le média lui est servi pendant l'ouverture (200)", lecture.status === 200, lecture.status);
verifie("toujours refusé à l'expéditeur (403)", (await appel(alice, `/api/media/${mediaId}`)).status === 403);
const reprise = await appel(bob, `/api/messages/${id}/vue-unique`, { method: "POST" });
verifie("une ouverture EN COURS se reprend (réseau coupé)", reprise.status === 200);
verifie(
  "une seule ligne d'ouverture",
  (await prisma.messageOuverture.count({ where: { messageId: id } })) === 1,
);
verifie("l'expéditeur la voit « ouverte »", (await messageVu(alice, convId, id))?.vueUniqueOuverte === true);

// ══════════════ ④ Fermeture ══════════════
titre("④ fermeture");
const ferme = await appel(bob, `/api/messages/${id}/vue-unique/fermer`, { method: "POST" });
verifie("fermer répond 200", ferme.status === 200);
verifie("le fichier a QUITTÉ LE DISQUE", !existsSync(disque), disque);
verifie("la ligne media_files a disparu", (await prisma.mediaFile.count({ where: { id: mediaId } })) === 0);
verifie("le média répond 404", (await appel(bob, `/api/media/${mediaId}`)).status === 404);
const encore = await appel(bob, `/api/messages/${id}/vue-unique`, { method: "POST" });
verifie("une seconde ouverture est refusée (410)", encore.status === 410, encore.status);
const final = await messageVu(alice, convId, id);
verifie("la liste l'annonce effacée", final?.vueUniqueEffacee === true, JSON.stringify(final));

await prisma.$disconnect();
console.log(echecs === 0 ? "\n\x1b[32mTout est vert.\x1b[0m" : `\n\x1b[31m${echecs} échec(s).\x1b[0m`);
process.exit(echecs ? 1 : 0);
