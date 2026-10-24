/**
 * BANC — LES DIFFUSIONS DU COMPTE OFFICIEL (lot 1b, 16/10/2026).
 *
 *   ① estimation par critères (pays, dates), refus des critères invalides ;
 *   ② refus : média, statut, texte vide, estimation obsolète, double envoi ;
 *   ③ diffusion immédiate : les bons destinataires, un message chacun, livré
 *     EN DIRECT à qui est connecté ; qui a bloqué le compte officiel est
 *     refusé, pas servi ;
 *   ④ reprise : une diffusion remise « en cours » n'écrit pas deux fois ;
 *   ⑤ planification : envoyée par la boucle de fond à l'échéance ;
 *     annulation d'une planifiée, et 404 la seconde fois ;
 *   ⑥ lecture seule : l'estimation passe, la création non.
 *
 * Durée : ~1 min 30 (la boucle de fond tourne toutes les 30 s).
 *
 * Usage (Next sur :3020, super-admin de banc de gestion-roles-banc.mjs, ws-server sur :3010) :
 *   API_URL=http://localhost:3020 WS_URL=ws://localhost:3010 \
 *     node --env-file=.env scripts/gestion-diffusions-banc.mjs
 *
 * ⚠️ BASE DE DÉVELOPPEMENT SEULEMENT. Tout ce que le banc crée est effacé à
 * la fin, sauf le compte officiel.
 */
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { PrismaClient } from "@prisma/client";

const API = process.env.API_URL ?? "http://localhost:3000";
const WS = process.env.WS_URL ?? "ws://localhost:3001";
const prisma = new PrismaClient();

let echecs = 0;
function verifie(libelle, condition, detail) {
  console.log(`  ${condition ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${libelle}`);
  if (!condition) {
    echecs++;
    if (detail !== undefined) console.log(`      \x1b[31m${JSON.stringify(detail)}\x1b[0m`);
  }
}
const titre = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function appel(methode, chemin, { jeton, corps } = {}) {
  const r = await fetch(`${API}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, json };
}
const jetonMobile = (id) => jwt.sign({ sub: id, scope: "access" }, process.env.JWT_ACCESS_SECRET, { expiresIn: "15m" });
const numero = () => String(Math.floor(10_000_000 + Math.random() * 89_999_999));
const idClient = (s) => `banc-diff-${s}-${Date.now()}`;

async function attendreStatut(jeton, id, attendus, ms = 20_000) {
  const fin = Date.now() + ms;
  let d;
  while (Date.now() < fin) {
    d = (await appel("GET", `/api/admin/broadcasts/${id}`, { jeton })).json;
    if (attendus.includes(d?.status)) return d;
    await pause(500);
  }
  return d;
}
const messagesOfficiels = (officielId, userId) =>
  prisma.message.count({ where: { senderId: officielId, conv: { participants: { some: { userId } } } } });

const T0 = new Date(Date.now() - 1000).toISOString();
const crees = [];
let rootLecture = null;
try {
  const admin = (
    await appel("POST", "/api/admin/auth/login", {
      corps: { email: process.env.ADMIN_IDENTIFIANT ?? "super@banc-gestion.test", password: process.env.ADMIN_MDP ?? "Banc-gestion-2026" },
    })
  ).json?.accessToken;
  let off = (await appel("GET", "/api/admin/official-account", { jeton: admin })).json;
  if (!off) off = (await appel("POST", "/api/admin/official-account", { jeton: admin })).json;

  const [p1, p2] = await prisma.pays.findMany({ take: 2, orderBy: { idPays: "asc" }, select: { idPays: true } });
  const nouveau = (nom, idPays) => prisma.user.create({ data: { publicNumber: numero(), nom, idPays, typeCompte: 0 } });
  const a = await nouveau("Banc Diff A", p1.idPays);
  const b = await nouveau("Banc Diff B", p1.idPays);
  const c = await nouveau("Banc Diff C", p2.idPays);
  crees.push(a.id, b.id, c.id);
  // B a bloqué le compte officiel : il doit être refusé, pas servi.
  await prisma.blocked.create({ data: { alanyaID: b.id, idCallerBlock: off.alanyaID } });

  const depuisT0 = { field: "created_at", op: "after", value: T0 };
  const crit = (...c) => ({ v: 1, op: "and", conditions: [depuisT0, ...c] });
  const critP1 = crit({ field: "idPays", op: "eq", value: p1.idPays });

  titre("① Estimation");
  const tous = await appel("POST", "/api/admin/broadcasts/estimate", { jeton: admin, corps: { criteria: crit() } });
  verifie("créés après T0 → 3", tous.json?.count === 3, tous);
  const pays1 = await appel("POST", "/api/admin/broadcasts/estimate", { jeton: admin, corps: { criteria: critP1 } });
  verifie("pays 1 → 2", pays1.json?.count === 2, pays1);
  const relatif = await appel("POST", "/api/admin/broadcasts/estimate", {
    jeton: admin,
    corps: { criteria: { v: 1, op: "and", conditions: [{ field: "last_seen", op: "before", value: { relative: "-30 days" } }] } },
  });
  verifie("date relative gelée en absolue", typeof relatif.json?.criteria?.conditions?.[0]?.value?.absolute === "string", relatif.json);
  const mauvais = await appel("POST", "/api/admin/broadcasts/estimate", {
    jeton: admin,
    corps: { criteria: { v: 1, op: "and", conditions: [{ field: "genre", op: "eq", value: "femme" }] } },
  });
  verifie("champ inconnu (genre) → 400 INVALID_CRITERIA", mauvais.status === 400 && mauvais.json?.code === "INVALID_CRITERIA", mauvais);

  titre("② Refus à la création");
  const base = { content: "Bonjour depuis le banc", criteria: critP1 };
  const media = await appel("POST", "/api/admin/broadcasts", { jeton: admin, corps: { ...base, type: 1, clientId: idClient("m") } });
  verifie("média → 400 MEDIA_NOT_SUPPORTED", media.json?.code === "MEDIA_NOT_SUPPORTED", media);
  const statut = await appel("POST", "/api/admin/broadcasts", { jeton: admin, corps: { ...base, isStatus: true, clientId: idClient("s") } });
  verifie("en statut → 400 STATUS_NOT_SUPPORTED", statut.json?.code === "STATUS_NOT_SUPPORTED", statut);
  const vide = await appel("POST", "/api/admin/broadcasts", { jeton: admin, corps: { ...base, content: "  ", clientId: idClient("v") } });
  verifie("texte vide → 400 CONTENT_REQUIRED", vide.json?.code === "CONTENT_REQUIRED", vide);
  const perime = await appel("POST", "/api/admin/broadcasts", {
    jeton: admin,
    corps: { ...base, confirmedEstimate: 7, clientId: idClient("p") },
  });
  verifie("estimation obsolète → 409 ESTIMATE_STALE, count = 2", perime.status === 409 && perime.json?.code === "ESTIMATE_STALE" && perime.json?.count === 2, perime);

  titre("③ Diffusion immédiate");
  const ws = new WebSocket(`${WS}?token=${jetonMobile(a.id)}`);
  const trames = [];
  ws.on("message", (x) => {
    try {
      trames.push(JSON.parse(x.toString()));
    } catch {}
  });
  await new Promise((r) => ws.on("open", r));
  const clientImmediat = idClient("i");
  const cree = await appel("POST", "/api/admin/broadcasts", {
    jeton: admin,
    corps: { ...base, confirmedEstimate: 2, clientId: clientImmediat },
  });
  verifie("201 et texte conservé", cree.status === 201 && cree.json?.content === base.content, cree);
  const double = await appel("POST", "/api/admin/broadcasts", { jeton: admin, corps: { ...base, clientId: clientImmediat } });
  verifie("même clientId → 409 ALREADY_EXISTS", double.status === 409 && double.json?.code === "ALREADY_EXISTS", double);
  const fini = await attendreStatut(admin, cree.json?.id, ["completed", "partial_failed"]);
  verifie("terminée : 1 envoyé (A), 1 refusé (B, bloqueur)", fini?.status === "completed" && fini?.deliveredCount === 1 && fini?.refusedCount === 1, fini);
  verifie("A a reçu un message officiel", (await messagesOfficiels(off.alanyaID, a.id)) === 1);
  verifie("B n'a rien reçu", (await messagesOfficiels(off.alanyaID, b.id)) === 0);
  verifie("C (autre pays) n'a rien reçu", (await messagesOfficiels(off.alanyaID, c.id)) === 0);
  const enDirect = trames.find((t) => t.type === "message" && t.message?.senderId === off.alanyaID);
  verifie("A connecté l'a reçu EN DIRECT (trame message)", enDirect?.message?.content === base.content, trames.map((t) => t.type));
  const motif = await prisma.diffusionEnvoi.findUnique({
    where: { diffusionId_userId: { diffusionId: BigInt(cree.json.id), userId: b.id } },
  });
  verifie("le refus de B est expliqué (BLOQUE)", motif?.statut === "refuse" && motif?.motif === "BLOQUE", motif);
  ws.close();

  titre("④ Reprise sans doublon, ⑤ planification");
  await prisma.diffusion.update({ where: { id: BigInt(cree.json.id) }, data: { statut: "en_cours", verrouJusqua: null } });
  const plan = await appel("POST", "/api/admin/broadcasts", {
    jeton: admin,
    corps: {
      content: "Diffusion planifiée",
      criteria: crit({ field: "idPays", op: "eq", value: p2.idPays }),
      scheduledAt: new Date(Date.now() + 3000).toISOString(),
      clientId: idClient("plan"),
    },
  });
  verifie("planifiée → 201 { scheduled: true }", plan.status === 201 && plan.json?.scheduled === true, plan);
  const liste = (await appel("GET", "/api/admin/broadcasts", { jeton: admin })).json;
  verifie("elle figure dans `scheduled`", liste?.scheduled?.some((s) => s.jobId === plan.json?.id), liste?.scheduled);
  console.log("  … attente de la boucle de fond (jusqu'à 40 s)");
  const planFinie = await attendreStatut(admin, plan.json?.id, ["completed", "partial_failed"], 45_000);
  verifie("planifiée envoyée par la boucle : C servi", planFinie?.status === "completed" && planFinie?.deliveredCount === 1, planFinie);
  verifie("C a reçu exactement 1 message", (await messagesOfficiels(off.alanyaID, c.id)) === 1);
  const repris = await attendreStatut(admin, cree.json?.id, ["completed"], 45_000);
  verifie("la diffusion reprise se termine", repris?.status === "completed", repris);
  verifie("A n'a TOUJOURS qu'un message (pas de doublon)", (await messagesOfficiels(off.alanyaID, a.id)) === 1);

  const loin = await appel("POST", "/api/admin/broadcasts", {
    jeton: admin,
    corps: { ...base, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), clientId: idClient("annule") },
  });
  const ann = await appel("DELETE", `/api/admin/broadcasts/scheduled/${loin.json?.id}`, { jeton: admin });
  verifie("annulation → 200", ann.status === 200, ann);
  const ann2 = await appel("DELETE", `/api/admin/broadcasts/scheduled/${loin.json?.id}`, { jeton: admin });
  verifie("seconde annulation → 404 JOB_NOT_FOUND", ann2.status === 404 && ann2.json?.code === "JOB_NOT_FOUND", ann2);

  titre("⑥ Lecture seule");
  rootLecture = await prisma.root.create({ data: { username: "banc-diff-lecture", password: "lecture-2026", type: 0, actif: 1 } });
  const lect = (await appel("POST", "/api/admin/auth/login", { corps: { username: "banc-diff-lecture", password: "lecture-2026" } })).json?.accessToken;
  const est = await appel("POST", "/api/admin/broadcasts/estimate", { jeton: lect, corps: { criteria: critP1 } });
  verifie("estimation permise → 200", est.status === 200, est);
  const env = await appel("POST", "/api/admin/broadcasts", { jeton: lect, corps: { ...base, clientId: idClient("l") } });
  verifie("création refusée → 403 READ_ONLY", env.status === 403 && env.json?.code === "READ_ONLY", env);
} finally {
  await prisma.diffusion.deleteMany({ where: { clientId: { startsWith: "banc-diff-" } } }).catch(() => {});
  if (rootLecture) await prisma.root.delete({ where: { idRoot: rootLecture.idRoot } }).catch(() => {});
  await prisma.blocked.deleteMany({ where: { alanyaID: { in: crees } } }).catch(() => {});
  for (const id of crees) {
    const ids = (await prisma.participant.findMany({ where: { userId: id }, select: { convId: true } })).map((p) => p.convId);
    await prisma.$transaction([
      prisma.message.deleteMany({ where: { convId: { in: ids } } }),
      prisma.participant.deleteMany({ where: { convId: { in: ids } } }),
      prisma.conversation.deleteMany({ where: { id: { in: ids } } }),
    ]).catch((e) => console.log(`  (nettoyage : ${e.message.split("\n")[0]})`));
  }
  await prisma.user.deleteMany({ where: { id: { in: crees } } }).catch((e) => console.log(`  (nettoyage : ${e.message.split("\n")[0]})`));
  await prisma.$disconnect();
}

console.log(echecs === 0 ? "\n\x1b[32mTout est vert.\x1b[0m" : `\n\x1b[31m${echecs} échec(s).\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
