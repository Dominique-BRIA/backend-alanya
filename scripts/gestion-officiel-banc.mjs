/**
 * BANC — LE COMPTE OFFICIEL « ALANYA WORK » ET LE REFUS DE RÉPONSE (16/10/2026).
 *
 *   ① la console le crée une fois, pas deux (409) ;
 *   ② la liste des conversations marque son fil `officiel` ;
 *   ③ on ne lui écrit pas : HTTP, WebSocket, transfert HTTP et WebSocket ;
 *   ④ on ne l'appelle pas : `call_ring` → `rejected` aussitôt ;
 *   ⑤ son fil ne peut pas être chiffré (HORS_PERIMETRE) ;
 *   ⑥ témoin : un fil ordinaire reçoit toujours les messages.
 *
 * Usage (Next sur :3020, super-admin de banc de gestion-roles-banc.mjs, ws-server sur :3010) :
 *   API_URL=http://localhost:3020 WS_URL=ws://localhost:3010 \
 *     node --env-file=.env scripts/gestion-officiel-banc.mjs
 *
 * ⚠️ BASE DE DÉVELOPPEMENT SEULEMENT : crée deux comptes de test et, s'il
 * n'existe pas encore, le compte officiel (qui reste ensuite en place).
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

/** Ouvre une socket et collecte ses trames. */
function socket(jeton) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}?token=${jeton}`);
    const trames = [];
    ws.on("message", (b) => {
      try {
        trames.push(JSON.parse(b.toString()));
      } catch {}
    });
    ws.on("open", () => resolve({ ws, trames }));
    ws.on("error", reject);
  });
}
async function attendre(trames, predicat, ms = 4000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    const t = trames.find(predicat);
    if (t) return t;
    await pause(50);
  }
  return null;
}

const crees = [];
try {
  titre("① Le compte officiel, créé par la console");
  const login = await appel("POST", "/api/admin/auth/login", {
    corps: { email: process.env.ADMIN_IDENTIFIANT ?? "super@banc-gestion.test", password: process.env.ADMIN_MDP ?? "Banc-gestion-2026" },
  });
  const admin = login.json?.accessToken;
  verifie("connexion du super-admin de banc", !!admin, login);
  let off = (await appel("GET", "/api/admin/official-account", { jeton: admin })).json;
  if (!off) {
    const c = await appel("POST", "/api/admin/official-account", { jeton: admin });
    verifie("POST → 201", c.status === 201, c);
    off = c.json;
  }
  verifie("typeCompte 5, nom Alanya Work", off?.typeCompte === 5 && off?.nom === "Alanya Work", off);
  verifie("photo = le logo du serveur", /\/logo-alanya\.png$/.test(off?.avatarUrl ?? ""), off?.avatarUrl);
  const deux = await appel("POST", "/api/admin/official-account", { jeton: admin });
  verifie("second POST → 409 OFFICIAL_ALREADY_EXISTS", deux.status === 409 && deux.json?.code === "OFFICIAL_ALREADY_EXISTS", deux);
  const ligne = await prisma.user.findUnique({ where: { id: off.alanyaID } });
  verifie("ni e-mail, ni mobile, ni mot de passe", !ligne.email && !ligne.mobile && !ligne.passwordHash);

  const a = await prisma.user.create({ data: { publicNumber: numero(), nom: "Banc Officiel A", typeCompte: 0 } });
  const b = await prisma.user.create({ data: { publicNumber: numero(), nom: "Banc Officiel B", typeCompte: 0 } });
  crees.push(a.id, b.id);
  const ja = jetonMobile(a.id);

  titre("② La liste marque le fil officiel");
  const convOff = (await appel("POST", "/api/conversations", { jeton: ja, corps: { publicNumber: off.alanyaPhone } })).json?.id;
  const convAB = (await appel("POST", "/api/conversations", { jeton: ja, corps: { publicNumber: b.publicNumber } })).json?.id;
  verifie("deux fils ouverts", !!convOff && !!convAB, { convOff, convAB });
  const liste = (await appel("GET", "/api/conversations", { jeton: ja })).json?.conversations ?? [];
  verifie("fil officiel : officiel = true", liste.find((c) => c.id === convOff)?.officiel === true);
  verifie("fil ordinaire : officiel = false", liste.find((c) => c.id === convAB)?.officiel === false);

  titre("⑥ Témoin : un fil ordinaire reçoit");
  const temoin = await appel("POST", `/api/conversations/${convAB}/messages`, { jeton: ja, corps: { type: "TEXT", content: "bonjour B" } });
  verifie("message à B accepté", temoin.status === 200 || temoin.status === 201, temoin);
  const idMessageAB = temoin.json?.id ?? temoin.json?.message?.id;

  titre("③ On n'écrit pas au compte officiel");
  const http = await appel("POST", `/api/conversations/${convOff}/messages`, { jeton: ja, corps: { type: "TEXT", content: "allô ?" } });
  verifie("HTTP → 403 COMPTE_OFFICIEL", http.status === 403 && http.json?.error?.code === "COMPTE_OFFICIEL", http);
  const fwd = await appel("POST", `/api/conversations/${convAB}/messages/forward`, {
    jeton: ja,
    corps: { messageId: idMessageAB, targetConvIds: [convOff] },
  });
  verifie("transfert HTTP → 403 COMPTE_OFFICIEL", fwd.status === 403 && fwd.json?.error?.code === "COMPTE_OFFICIEL", fwd);

  const { ws, trames } = await socket(ja);
  await attendre(trames, (t) => t.type === "ready");
  ws.send(JSON.stringify({ type: "send", convId: convOff, tempId: "banc-off-1", content: "allô par la socket" }));
  const err = await attendre(trames, (t) => t.type === "error" && t.tempId === "banc-off-1");
  verifie("WebSocket → error COMPTE_OFFICIEL", err?.code === "COMPTE_OFFICIEL", err);
  ws.send(JSON.stringify({ type: "forward_message", messageId: idMessageAB, targetConvIds: [convOff] }));
  await pause(1500);
  const dansOff = await prisma.message.count({ where: { convId: convOff } });
  verifie("aucun message n'est entré dans le fil officiel", dansOff === 0, dansOff);

  titre("④ On n'appelle pas le compte officiel");
  const callRep = await appel("POST", "/api/calls", { jeton: ja, corps: { convId: convOff, type: "AUDIO" } });
  const callId = callRep.json?.id ?? callRep.json?.call?.id;
  verifie("appel créé côté REST", !!callId, callRep);
  ws.send(JSON.stringify({ type: "call_ring", callId }));
  const etat = await attendre(trames, (t) => t.type === "call_state" && t.callId === callId);
  verifie("call_ring → rejected, code COMPTE_OFFICIEL", etat?.state === "rejected" && etat?.code === "COMPTE_OFFICIEL", etat);
  ws.close();

  titre("⑤ Le fil officiel ne se chiffre pas");
  const e2ee = await appel("GET", `/api/conversations/${convOff}/e2ee`, { jeton: ja });
  verifie("activable = false, motif HORS_PERIMETRE", e2ee.json?.activable === false && e2ee.json?.motif === "HORS_PERIMETRE", e2ee.json);
} finally {
  // Nettoyage best-effort : les fils de test et leurs dépendances.
  for (const id of crees) {
    const convs = await prisma.participant.findMany({ where: { userId: id }, select: { convId: true } });
    const ids = convs.map((c) => c.convId);
    await prisma.$transaction([
      prisma.callParticipant.deleteMany({ where: { call: { convId: { in: ids } } } }),
      prisma.call.deleteMany({ where: { convId: { in: ids } } }),
      prisma.message.deleteMany({ where: { convId: { in: ids } } }),
      prisma.participant.deleteMany({ where: { convId: { in: ids } } }),
      prisma.conversation.deleteMany({ where: { id: { in: ids } } }),
    ]).catch((e) => console.log(`  (nettoyage des fils : ${e.message.split("\n")[0]})`));
  }
  await prisma.user.deleteMany({ where: { id: { in: crees } } }).catch((e) => console.log(`  (nettoyage des comptes : ${e.message.split("\n")[0]})`));
  await prisma.$disconnect();
}

console.log(echecs === 0 ? "\n\x1b[32mTout est vert.\x1b[0m" : `\n\x1b[31m${echecs} échec(s).\x1b[0m`);
process.exit(echecs === 0 ? 0 : 1);
