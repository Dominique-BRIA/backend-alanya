/**
 * BANC — PUBLICATION DIFFÉRÉE d'un envoi en morceaux (10/10/2026, lot 1b).
 *
 * L'appareil prépare le message (identifiant, enveloppes ou chiffré de
 * groupe) au premier plan ; le SERVEUR le publie quand le dernier morceau est
 * assemblé — application fermée depuis, au besoin.
 *
 *   ① programmation refusée : sans identifiant, fichier en clair, fil non
 *     chiffré, fil étranger, destinataire étranger, charge de groupe en
 *     tête-à-tête, envoi d'un autre compte ;
 *   ② tête-à-tête : programmer, envoyer, et le message existe avec SON
 *     identifiant, son média (= l'envoi) et ses enveloppes, que le
 *     destinataire relève ; reprogrammer le même = sans effet, un autre = 409 ;
 *   ③ programmé APRÈS la fin du fichier : publié sur-le-champ ;
 *   ④ blocage survenu pendant l'envoi : refus:BLOQUE, le média reste ;
 *   ⑤ groupe : publié, chiffré du groupe écrit avec la ligne ;
 *   ⑥ groupe, clé changée pendant l'envoi : refus:VERSION_PERIMEE ;
 *   ⑦ serveur arrêté entre l'assemblage et la publication : `…/terminer` relance.
 *
 * Usage :
 *   node --env-file=.env scripts/publication-differee-banc.mjs
 *       (serveur Next :3000 démarré, stockage LOCAL)
 */
import crypto, { randomUUID, randomBytes } from "node:crypto";
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
const titre = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const corpsGroupe = () => Buffer.concat([Buffer.from([1]), randomBytes(120)]).toString("base64");
const enveloppe = (qui, device = 1, type = 3) => ({
  destinataireId: qui.user.id,
  destinataireDevice: device,
  type,
  corps: randomBytes(90).toString("base64"),
});

async function compte(marque) {
  const email = `pd-${marque}@banc.test`;
  const motDePasse = "MotDePasseDeTest!2026";
  const hash = await bcrypt.hash(motDePasse, 12);
  const user = await prisma.user.upsert({
    where: { email },
    update: { passwordHash: hash, emailVerified: true, typeCompte: 0 },
    create: {
      email,
      nom: `Publication ${marque}`,
      passwordHash: hash,
      publicNumber: `8${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`,
      emailVerified: true,
      typeCompte: 0,
    },
  });
  await prisma.e2eeIdentite.deleteMany({ where: { userId: user.id } });
  await prisma.e2eeIdentite.create({
    data: {
      userId: user.id,
      deviceId: 1,
      registrationId: 1000 + Math.floor(Math.random() * 9000),
      cleIdentite: Buffer.concat([Buffer.from([5]), randomBytes(32)]).toString("base64"),
    },
  });
  const r = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": `10.97.${Math.floor(Math.random() * 250)}.${marque.charCodeAt(0)}`,
    },
    body: JSON.stringify({ identifier: email, password: motDePasse, deviceId: `banc-publication-${marque}`, typeDevice: 0 }),
  });
  if (!r.ok) throw new Error(`login ${marque} → ${r.status} ${await r.text()}`);
  return { user, jeton: (await r.json()).accessToken };
}

async function reserver(qui, fichier, chiffre = true) {
  const r = await fetch(`${API}/api/media/envois`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${qui.jeton}` },
    body: JSON.stringify({ taille: fichier.length, nom: "chiffre.bin", mime: "application/octet-stream", chiffre, empreinte: sha(fichier) }),
  });
  const corps = await r.json();
  if (r.status !== 201) throw new Error(`réservation → ${r.status} ${JSON.stringify(corps)}`);
  return corps;
}

function morceau(envoi, fichier, n) {
  const debut = n * envoi.tailleMorceau;
  return fetch(`${API}/api/media/envois/${envoi.id}/morceaux/${n}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream", "X-Envoi-Jeton": envoi.jeton },
    body: fichier.subarray(debut, Math.min(debut + envoi.tailleMorceau, fichier.length)),
  }).then(async (r) => ({ statut: r.status, corps: await r.json() }));
}

async function toutEnvoyer(envoi, fichier) {
  let dernier;
  for (let n = 0; n < envoi.nbMorceaux; n++) dernier = await morceau(envoi, fichier, n);
  return dernier;
}

const programmer = (qui, envoi, corps) =>
  fetch(`${API}/api/media/envois/${envoi.id}/publication`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${qui.jeton}` },
    body: JSON.stringify(corps),
  }).then(async (r) => ({ statut: r.status, corps: await r.json() }));

async function filADeux(a, b, chiffre) {
  const c = await prisma.conversation.create({
    data: { isGroup: false, e2eeActif: chiffre, participants: { create: [{ userId: a.user.id }, { userId: b.user.id }] } },
    select: { id: true },
  });
  return c.id;
}

// -----------------------------------------------------------------------------
const A = await compte("a");
const B = await compte("b");
const C = await compte("c");
await prisma.blocked.deleteMany({ where: { OR: [{ alanyaID: A.user.id }, { alanyaID: B.user.id }] } });

const T = await filADeux(A, B, true);
const CLAIR = await filADeux(A, B, false);
const ETRANGER = await filADeux(B, C, true);
const G = (
  await prisma.conversation.create({
    data: {
      isGroup: true,
      name: "Banc publication",
      e2eeActif: true,
      cleVersion: 1,
      participants: { create: [{ userId: A.user.id, role: "ADMIN" }, { userId: B.user.id, role: "MEMBER" }] },
    },
    select: { id: true },
  })
).id;
// Un groupe chiffré a sa version de clé enregistrée (clé étrangère du chiffré).
await prisma.e2eeCleVersion.create({
  data: { convId: G, version: 1, creePar: A.user.id, creeParAppareil: 1, motif: "ACTIVATION" },
});

const Mo = 1024 * 1024;
const fichier = randomBytes(2 * Mo + 12345);

titre("① Programmation refusée");
{
  const e = await reserver(A, fichier);
  const base = { convId: T, type: "VIDEO", messageId: randomUUID(), deviceId: 1, enveloppes: [enveloppe(B)] };
  let r = await programmer(A, e, { ...base, messageId: "pas-un-uuid" });
  verifie("sans identifiant UUID v4 → 400", r.statut === 400, JSON.stringify(r.corps));
  const clair = await reserver(A, fichier, false);
  r = await programmer(A, clair, base);
  verifie("fichier en clair → 422 PUBLICATION_EN_CLAIR", r.statut === 422 && r.corps.error?.code === "PUBLICATION_EN_CLAIR");
  r = await programmer(A, e, { ...base, convId: CLAIR });
  verifie("fil non chiffré → 409", r.statut === 409 && r.corps.error?.code === "CONVERSATION_NON_CHIFFREE");
  r = await programmer(A, e, { ...base, convId: ETRANGER });
  verifie("fil dont on n'est pas membre → 404", r.statut === 404);
  r = await programmer(A, e, { ...base, enveloppes: [enveloppe(B), enveloppe(C)] });
  verifie("destinataire hors du fil → 403", r.statut === 403 && r.corps.error?.code === "FORBIDDEN");
  r = await programmer(A, e, { ...base, enveloppes: [] });
  verifie("aucune enveloppe → 400", r.statut === 400);
  r = await programmer(A, e, { ...base, groupe: { version: 1, appareil: 1, corps: corpsGroupe() } });
  verifie("charge de groupe en tête-à-tête → 400", r.statut === 400 && r.corps.error?.code === "CHARGE_GROUPE_INVALIDE");
  r = await programmer(B, e, { ...base, enveloppes: [enveloppe(A)] });
  verifie("l'envoi d'un autre compte → 404", r.statut === 404);
  const etat = await prisma.envoiMorceaux.findUnique({ where: { id: e.id } });
  verifie("rien n'a été programmé", etat.publicationEtat === null && etat.publication === null);
}

titre("② Tête-à-tête : programmer, envoyer, publié");
{
  const e = await reserver(A, fichier);
  verifie("la réservation annonce l'identifiant du média (= l'envoi)", e.mediaId === e.id);
  const messageId = randomUUID();
  const corps = {
    convId: T,
    type: "VIDEO",
    messageId,
    deviceId: 1,
    // Pour B, et pour un second appareil de A (ses copies).
    enveloppes: [enveloppe(B, 1, 3), enveloppe(A, 2, 1)],
  };
  let r = await programmer(A, e, corps);
  verifie("programmé : attente", r.statut === 200 && r.corps.etat === "attente", JSON.stringify(r.corps));
  r = await programmer(A, e, corps);
  verifie("reprogrammer le même message : sans effet", r.statut === 200 && r.corps.etat === "attente");
  r = await programmer(A, e, { ...corps, messageId: randomUUID() });
  verifie("programmer un autre message → 409", r.statut === 409 && r.corps.error?.code === "PUBLICATION_DEJA_PROGRAMMEE");

  const avant = await prisma.message.count({ where: { convId: T } });
  const premier = await morceau(e, fichier, 0);
  verifie("un morceau ne publie rien", premier.corps.termine === false && (await prisma.message.count({ where: { convId: T } })) === avant);
  await morceau(e, fichier, 1);
  const fin = await morceau(e, fichier, 2);
  verifie("dernier morceau : publié", fin.corps.termine === true && fin.corps.publication?.etat === "publie", JSON.stringify(fin.corps));
  verifie("avec l'identifiant tiré par l'appareil", fin.corps.publication?.messageId === messageId);

  const m = await prisma.message.findUnique({ where: { id: messageId }, include: { media: true } });
  verifie("le message existe, dans le bon fil, de A", m?.convId === T && m?.senderId === A.user.id);
  verifie("type VIDEO, sans aucun texte", m?.type === "VIDEO" && (m?.content ?? "") === "");
  verifie("son média est celui de l'envoi, chiffré", m?.media.length === 1 && m.media[0].id === e.id && m.media[0].chiffre === true);
  const env = await prisma.e2eeEnveloppe.findMany({ where: { messageId } });
  verifie("2 enveloppes déposées, rattachées au message", env.length === 2, env.length);
  const releve = await fetch(`${API}/api/e2ee/enveloppes?deviceId=1`, { headers: { Authorization: `Bearer ${B.jeton}` } });
  const lues = (await releve.json()).enveloppes ?? (await Promise.resolve([]));
  verifie("B relève son enveloppe", Array.isArray(lues) && lues.some((x) => x.messageId === messageId), JSON.stringify(lues).slice(0, 200));
  const ligne = await prisma.envoiMorceaux.findUnique({ where: { id: e.id } });
  verifie("le double des enveloppes est effacé de l'envoi", ligne.publication === null && ligne.messageId === messageId);
  const conv = await prisma.conversation.findUnique({ where: { id: T } });
  verifie("la liste des conversations est à jour", conv.lastMessageSenderID === A.user.id && conv.lastMessageType === 4);
}

titre("③ Programmé après la fin du fichier");
{
  const petit = randomBytes(200 * 1024);
  const e = await reserver(A, petit);
  const fin = await morceau(e, petit, 0);
  verifie("fichier terminé, rien à publier", fin.corps.termine === true && fin.corps.publication?.etat === null);
  const messageId = randomUUID();
  const r = await programmer(A, e, { convId: T, type: "IMAGE", messageId, deviceId: 1, enveloppes: [enveloppe(B)] });
  verifie("publié sur-le-champ", r.statut === 200 && r.corps.etat === "publie" && r.corps.messageId === messageId, JSON.stringify(r.corps));
}

titre("④ Blocage survenu pendant l'envoi");
{
  const e = await reserver(A, fichier);
  const messageId = randomUUID();
  await programmer(A, e, { convId: T, type: "FILE", messageId, deviceId: 1, enveloppes: [enveloppe(B)] });
  await morceau(e, fichier, 0);
  await morceau(e, fichier, 1);
  await prisma.blocked.create({ data: { alanyaID: B.user.id, idCallerBlock: A.user.id } });
  const fin = await morceau(e, fichier, 2);
  verifie("le morceau est accepté (Android ne doit pas le renvoyer)", fin.statut === 200 && fin.corps.termine === true);
  verifie("publication refusée : refus:BLOQUE", fin.corps.publication?.etat === "refus:BLOQUE", JSON.stringify(fin.corps.publication));
  verifie("aucun message écrit", (await prisma.message.findUnique({ where: { id: messageId } })) === null);
  verifie("le média reste (l'appareil pourra le réutiliser)", (await prisma.mediaFile.findUnique({ where: { id: e.id } })) !== null);
  await prisma.blocked.deleteMany({ where: { alanyaID: B.user.id } });
}

titre("⑤ Groupe chiffré");
{
  const e = await reserver(A, fichier);
  const messageId = randomUUID();
  let r = await programmer(A, e, { convId: G, type: "IMAGE", messageId, enveloppes: [enveloppe(B)], groupe: { version: 1, appareil: 1, corps: corpsGroupe() } });
  verifie("enveloppes en groupe → 400", r.statut === 400);
  r = await programmer(A, e, { convId: G, type: "IMAGE", messageId, groupe: { version: 1, appareil: 1, corps: "pas du base64" } });
  verifie("charge de groupe mal formée → 400", r.statut === 400 && r.corps.error?.code === "CHARGE_GROUPE_INVALIDE");
  r = await programmer(A, e, { convId: G, type: "IMAGE", messageId, groupe: { version: 1, appareil: 1, corps: corpsGroupe() } });
  verifie("programmé", r.statut === 200 && r.corps.etat === "attente", JSON.stringify(r.corps));
  const fin = await toutEnvoyer(e, fichier);
  verifie("publié", fin.corps.publication?.etat === "publie", JSON.stringify(fin.corps.publication));
  const m = await prisma.message.findUnique({ where: { id: messageId }, include: { groupe: true, media: true } });
  verifie("le chiffré du groupe est écrit avec la ligne", m?.groupe !== null && m?.groupe !== undefined && m.media[0]?.id === e.id, JSON.stringify(m?.groupe));
}

titre("⑥ Groupe : clé changée pendant l'envoi");
{
  const e = await reserver(A, fichier);
  const messageId = randomUUID();
  await programmer(A, e, { convId: G, type: "IMAGE", messageId, groupe: { version: 1, appareil: 1, corps: corpsGroupe() } });
  await prisma.conversation.update({ where: { id: G }, data: { cleVersion: 2 } });
  const fin = await toutEnvoyer(e, fichier);
  verifie("refus:VERSION_PERIMEE", fin.corps.publication?.etat === "refus:VERSION_PERIMEE", JSON.stringify(fin.corps.publication));
  verifie("aucun message écrit", (await prisma.message.findUnique({ where: { id: messageId } })) === null);
}

titre("⑦ Serveur arrêté entre l'assemblage et la publication");
{
  const petit = randomBytes(100 * 1024);
  const e = await reserver(A, petit);
  await morceau(e, petit, 0);
  const messageId = randomUUID();
  // Ce qu'aurait laissé un arrêt brutal : programmé, fichier assemblé, rien publié.
  await prisma.envoiMorceaux.update({
    where: { id: e.id },
    data: {
      publicationEtat: "attente",
      publication: { convId: T, type: "IMAGE", messageId, deviceId: 1, enveloppes: [enveloppe(B)] },
    },
  });
  const r = await fetch(`${API}/api/media/envois/${e.id}/terminer`, { method: "POST", headers: { "X-Envoi-Jeton": e.jeton } });
  const corps = await r.json();
  verifie("…/terminer publie", r.status === 200 && corps.publication?.etat === "publie" && corps.publication?.messageId === messageId, JSON.stringify(corps));
}

// Ménage.
await prisma.envoiMorceaux.deleteMany({ where: { ownerId: { in: [A.user.id, B.user.id] } } });
await prisma.conversation.deleteMany({ where: { id: { in: [T, CLAIR, ETRANGER, G] } } });
await prisma.$disconnect();
console.log(echecs === 0 ? "\n\x1b[32mTous les contrôles passent.\x1b[0m" : `\n\x1b[31m${echecs} ÉCHEC(S).\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
