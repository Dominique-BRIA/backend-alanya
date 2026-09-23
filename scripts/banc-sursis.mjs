/**
 * Banc d'essai du sursis de reconnexion (lot 1).
 *
 * Il parle au VRAI ws-server lancé en local sur la base de dev : deux comptes,
 * un appel décroché en base, puis on coupe la socket de A et on regarde ce que
 * B reçoit et ce que la base devient.
 *
 * Usage : WS_PORT=3010 SURSIS_RECONNEXION_MS=6000 node banc-sursis.mjs
 */
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { PrismaClient } from "@prisma/client";

const PORT = process.env.WS_PORT ?? "3010";
const SECRET = process.env.JWT_ACCESS_SECRET;
const prisma = new PrismaClient();

const jeton = (sub) => jwt.sign({ sub, scope: "access" }, SECRET, { expiresIn: "1h" });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function ouvre(userId, recu) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}?token=${jeton(userId)}`);
    ws.on("message", (raw) => {
      try {
        recu.push(JSON.parse(raw.toString()));
      } catch {}
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

const etats = (recu, callId) =>
  recu.filter((m) => m.type === "call_state" && m.callId === callId).map((m) => m.state);

let echecs = 0;
function verifie(ok, libelle, detail = "") {
  console.log(`${ok ? "  OK  " : "ECHEC "} ${libelle}${detail ? "  — " + detail : ""}`);
  if (!ok) echecs++;
}

async function creeAppel(a, b) {
  const appel = await prisma.call.create({
    data: {
      initiatorId: a,
      type: "AUDIO",
      status: "ONGOING",
      startedAt: new Date(),
      answeredAt: new Date(),
    },
    select: { id: true },
  });
  for (const uid of [a, b]) {
    await prisma.callParticipant.create({
      data: { callId: appel.id, userId: uid, joinedAt: new Date() },
    });
  }
  return appel.id;
}

const statut = async (id) =>
  (await prisma.call.findUnique({ where: { id }, select: { status: true } }))?.status;

async function main() {
  const [a, b] = await prisma.user.findMany({ take: 2, select: { id: true } });
  if (!a || !b) throw new Error("il faut deux comptes dans la base de dev");
  const sursisMs = Number(process.env.SURSIS_RECONNEXION_MS ?? 45000);
  console.log(`\nsursis annoncé : ${sursisMs} ms\n`);

  // ---------------------------------------------------------------- scénario 1
  console.log("SCÉNARIO 1 — A perd le réseau, revient avant l'échéance");
  let callId = await creeAppel(a.id, b.id);
  const recuB = [];
  const wsB = await ouvre(b.id, recuB);
  let wsA = await ouvre(a.id, []);
  await pause(400);

  wsA.terminate(); // coupure brutale, comme un tunnel
  await pause(900);

  verifie(
    etats(recuB, callId).includes("reconnecting"),
    "B est prévenu « reconnecting »",
    etats(recuB, callId).join(",") || "rien reçu",
  );
  verifie((await statut(callId)) === "ONGOING", "l'appel reste ONGOING pendant le sursis", await statut(callId));

  wsA = await ouvre(a.id, []);
  await pause(900);
  verifie(
    etats(recuB, callId).includes("resumed"),
    "B est prévenu « resumed » au retour de A",
    etats(recuB, callId).join(","),
  );
  verifie((await statut(callId)) === "ONGOING", "l'appel a survécu à la coupure", await statut(callId));

  wsA.terminate();
  wsB.terminate();
  await pause(sursisMs + 1500);

  // ---------------------------------------------------------------- scénario 2
  console.log("\nSCÉNARIO 2 — A ne revient jamais");
  callId = await creeAppel(a.id, b.id);
  const recuB2 = [];
  const wsB2 = await ouvre(b.id, recuB2);
  const wsA2 = await ouvre(a.id, []);
  await pause(400);
  wsA2.terminate();

  await pause(1000);
  verifie((await statut(callId)) === "ONGOING", "toujours ONGOING juste après la coupure", await statut(callId));

  await pause(sursisMs + 1500);
  verifie((await statut(callId)) === "ENDED", "clôturé une fois le sursis écoulé", await statut(callId));
  verifie(etats(recuB2, callId).includes("ended"), "B reçoit « ended » à la clôture", etats(recuB2, callId).join(","));

  wsB2.terminate();

  // ---------------------------------------------------------------- scénario 3
  console.log("\nSCÉNARIO 3 — la sonnerie ne bénéficie d'aucun sursis");
  const sonnerie = await prisma.call.create({
    data: { initiatorId: a.id, type: "AUDIO", status: "RINGING", startedAt: new Date() },
    select: { id: true },
  });
  await prisma.callParticipant.create({ data: { callId: sonnerie.id, userId: a.id, joinedAt: new Date() } });
  await prisma.callParticipant.create({ data: { callId: sonnerie.id, userId: b.id } });
  const wsA3 = await ouvre(a.id, []);
  await pause(400);
  wsA3.terminate();
  await pause(1200);
  verifie(
    (await statut(sonnerie.id)) !== "RINGING",
    "une sonnerie abandonnée se ferme tout de suite",
    await statut(sonnerie.id),
  );

  // ---------------------------------------------------------------- scénario 4
  console.log("\nSCÉNARIO 4 — « call_rejoin », sur un appel vivant puis sur un appel clos");
  callId = await creeAppel(a.id, b.id);
  const recuA4 = [];
  const wsA4 = await ouvre(a.id, recuA4);
  const wsB4 = await ouvre(b.id, []);
  await pause(400);

  wsA4.send(JSON.stringify({ type: "call_rejoin", callId }));
  await pause(700);
  const repriseVivante = recuA4.find((m) => m.type === "call_rejoined" && m.callId === callId);
  verifie(!!repriseVivante, "appel vivant : le serveur répond « call_rejoined »");
  verifie(
    !!repriseVivante && repriseVivante.participants?.includes(b.id) && !repriseVivante.participants?.includes(a.id),
    "il annonce le correspondant, et pas moi-même",
    JSON.stringify(repriseVivante?.participants ?? null),
  );

  // Un rappel sur une socket qui n'était pas tombée ne doit rien casser.
  wsA4.send(JSON.stringify({ type: "call_rejoin", callId }));
  await pause(500);
  verifie((await statut(callId)) === "ONGOING", "un rejoin répété est sans effet (idempotent)", await statut(callId));

  await prisma.call.update({ where: { id: callId }, data: { status: "ENDED", endedAt: new Date() } });
  const avant = recuA4.length;
  wsA4.send(JSON.stringify({ type: "call_rejoin", callId }));
  await pause(700);
  const reponseClose = recuA4
    .slice(avant)
    .find((m) => m.type === "call_state" && m.callId === callId && m.state === "ended");
  verifie(!!reponseClose, "appel déjà clos : le serveur répond « ended » au lieu de laisser attendre");

  wsA4.terminate();
  wsB4.terminate();

  console.log(`\n${echecs === 0 ? "TOUT EST VERT" : echecs + " ÉCHEC(S)"}\n`);
  await prisma.$disconnect();
  process.exit(echecs === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("banc d'essai interrompu :", e);
  await prisma.$disconnect();
  process.exit(2);
});
