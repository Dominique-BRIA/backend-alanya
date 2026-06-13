// Serveur WebSocket temps réel d'Alanya (process séparé du serveur Next.js).
// - Authentifie chaque connexion via le JWT d'accès (?token=...).
// - Reçoit les messages, les persiste (Prisma) puis les diffuse aux participants.
// - Gère les accusés de lecture et l'indicateur « est en train d'écrire ».
//
// Lancement : npm run ws  (équivaut à `node --env-file=.env ws-server.mjs`)
import { WebSocketServer } from "ws";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { parse } from "node:url";
import { isPushEnabled, pushIncomingCall, pushNewMessage } from "./push.mjs";

const prisma = new PrismaClient();
// Render injecte automatiquement $PORT. WS_PORT sert pour le dev local.
const PORT = Number(process.env.PORT ?? process.env.WS_PORT ?? 3001);
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;

if (!ACCESS_SECRET) {
  console.error("[ws] JWT_ACCESS_SECRET manquant. Lance via `npm run ws` (charge .env).");
  process.exit(1);
}

// userId -> Set<WebSocket>
const clients = new Map();

function addClient(userId, ws) {
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
}

function removeClient(userId, ws) {
  const set = clients.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) clients.delete(userId);
}

function sendTo(userId, payload) {
  const set = clients.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function isUserOnline(userId) {
  const set = clients.get(userId);
  return Boolean(set?.size);
}

async function participantsOf(convId) {
  const parts = await prisma.participant.findMany({
    where: { convId },
    select: { userId: true },
  });
  return parts.map((p) => p.userId);
}

async function isParticipant(convId, userId) {
  const p = await prisma.participant.findUnique({
    where: { convId_userId: { convId, userId } },
    select: { id: true },
  });
  return Boolean(p);
}

function serializeMessage(m, media) {
  return {
    id: m.id,
    convId: m.convId,
    senderId: m.senderId,
    content: m.content,
    type: m.type,
    status: m.status,
    replyToId: m.replyToId,
    media: (media ?? []).map((f) => ({
      id: f.id,
      url: `/api/media/${f.id}`,
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      durationMs: f.durationMs,
    })),
    createdAt: m.createdAt,
  };
}

async function handleSend(ws, msg) {
  const { convId, content, tempId, mediaId } = msg;
  const type = msg.msgType ?? "TEXT"; // 'type' = type d'enveloppe ; 'msgType' = type du message
  // TEXT exige un contenu ; les autres types exigent un média.
  if (!convId) return;
  if (type === "TEXT" && (!content || !content.trim())) return;
  if (type !== "TEXT" && !mediaId) return;
  if (!(await isParticipant(convId, ws.userId))) {
    ws.send(JSON.stringify({ type: "error", message: "Conversation interdite", tempId }));
    return;
  }

  // Vérifie la propriété du média le cas échéant.
  if (mediaId) {
    const media = await prisma.mediaFile.findUnique({ where: { id: mediaId }, select: { ownerId: true } });
    if (!media || media.ownerId !== ws.userId) {
      ws.send(JSON.stringify({ type: "error", message: "Média invalide", tempId }));
      return;
    }
  }

  const created = await prisma.message.create({
    data: {
      convId,
      senderId: ws.userId,
      content: content ?? null,
      type,
      status: "SENT",
      replyToId: msg.replyToId ?? null,
      ...(mediaId ? { media: { connect: { id: mediaId } } } : {}),
    },
    include: { media: true },
  });
  await prisma.conversation.update({ where: { id: convId }, data: { updatedAt: new Date() } });

  const serialized = serializeMessage(created, created.media);
  const recipients = await participantsOf(convId);
  for (const uid of recipients) {
    // On renvoie le tempId uniquement à l'expéditeur pour réconcilier l'optimiste.
    sendTo(uid, {
      type: "message",
      message: serialized,
      tempId: uid === ws.userId ? tempId : undefined,
    });
  }

  if (isPushEnabled()) {
    const sender = await prisma.user.findUnique({
      where: { id: ws.userId },
      include: { profile: true },
    });
    const senderName = sender?.profile?.displayName ?? sender?.publicNumber ?? "Quelqu'un";
    const conv = await prisma.conversation.findUnique({
      where: { id: convId },
      include: { participants: { include: { user: { include: { profile: true } } } } },
    });
    let convTitle = conv?.name ?? null;
    if (conv && !conv.isGroup) {
      const other = conv.participants.find((p) => p.userId !== ws.userId);
      convTitle = other?.user.profile?.displayName ?? other?.user.publicNumber ?? convTitle;
    }
    const preview = type === "TEXT" ? (content ?? "").slice(0, 120) : null;

    for (const uid of recipients) {
      if (uid === ws.userId || isUserOnline(uid)) continue;
      await pushNewMessage(prisma, {
        recipientId: uid,
        senderName,
        convId,
        convTitle: convTitle ?? senderName,
        preview,
        messageType: type,
      });
    }
  }
}

async function handleRead(ws, msg) {
  const { convId } = msg;
  if (!convId || !(await isParticipant(convId, ws.userId))) return;
  const now = new Date();
  await prisma.participant.update({
    where: { convId_userId: { convId, userId: ws.userId } },
    data: { lastReadAt: now },
  });
  const recipients = await participantsOf(convId);
  for (const uid of recipients) {
    if (uid === ws.userId) continue;
    sendTo(uid, { type: "read", convId, userId: ws.userId, at: now });
  }
}

async function handleTyping(ws, msg) {
  const { convId, isTyping } = msg;
  if (!convId || !(await isParticipant(convId, ws.userId))) return;
  const recipients = await participantsOf(convId);
  for (const uid of recipients) {
    if (uid === ws.userId) continue;
    sendTo(uid, { type: "typing", convId, userId: ws.userId, isTyping: Boolean(isTyping) });
  }
}

async function callParticipantIds(callId) {
  const parts = await prisma.callParticipant.findMany({
    where: { callId },
    select: { userId: true },
  });
  return parts.map((p) => p.userId);
}

// Notifie les autres participants qu'un appel sonne (après POST /api/calls).
async function handleCallRing(ws, msg) {
  const { callId } = msg;
  if (!callId) return;
  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: { initiator: { include: { profile: true } } },
  });
  if (!call || call.initiatorId !== ws.userId || call.status !== "RINGING") return;

  const callerName = call.initiator.profile?.displayName ?? call.initiator.publicNumber;
  let isGroup = false;
  let groupName = null;
  let memberCount = 0;
  if (call.convId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: call.convId },
      include: { participants: true },
    });
    isGroup = conv?.isGroup ?? false;
    groupName = conv?.name ?? null;
    memberCount = conv?.participants.length ?? 0;
  }
  const targets = await callParticipantIds(callId);
  for (const uid of targets) {
    if (uid === ws.userId) continue;
    sendTo(uid, {
      type: "incoming_call",
      callId,
      convId: call.convId,
      callType: call.type,
      callerId: ws.userId,
      callerName,
      isGroup,
      groupName,
      memberCount,
    });
    if (isPushEnabled()) {
      await pushIncomingCall(prisma, {
        recipientId: uid,
        callId,
        convId: call.convId,
        callerName,
        callType: call.type,
        isGroup,
        groupName,
      });
    }
  }
}

// Relaie la signalisation WebRTC (offer / answer / ICE) entre participants.
async function handleCallSignal(ws, msg) {
  const { callId, toUserId, signal } = msg;
  if (!callId || !toUserId || !signal) return;
  const ids = await callParticipantIds(callId);
  if (!ids.includes(ws.userId) || !ids.includes(toUserId)) return;
  sendTo(toUserId, { type: "call_signal", callId, from: ws.userId, signal });
}

// Diffuse un changement d'état d'appel (accepté, refusé, terminé).
async function handleCallState(ws, msg) {
  const { callId, state, userId: joinedUserId, displayName } = msg;
  if (!callId || !state) return;
  const ids = await callParticipantIds(callId);
  if (!ids.includes(ws.userId)) return;
  const payload = {
    type: "call_state",
    callId,
    state,
    from: ws.userId,
    userId: joinedUserId ?? ws.userId,
    displayName: displayName ?? null,
  };
  for (const uid of ids) {
    // Envoie à tous les participants, y compris l'émetteur lui-même
    // pour synchroniser ses autres appareils connectés.
    sendTo(uid, payload);
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[ws] Le port ${PORT} est déjà utilisé — une instance tourne peut-être déjà.\n` +
        `       Arrête l'ancienne (Ctrl+C dans son terminal) ou : fuser -k ${PORT}/tcp`,
    );
  } else {
    console.error("[ws] Erreur serveur:", err);
  }
  process.exit(1);
});

wss.on("listening", () => {
  console.log(`[ws] Serveur WebSocket Alanya à l'écoute sur ws://localhost:${PORT}`);
});

wss.on("connection", (ws, req) => {
  // Authentification : ?token=<accessToken>
  const { query } = parse(req.url ?? "", true);
  const token = Array.isArray(query.token) ? query.token[0] : query.token;
  let userId;
  try {
    const payload = jwt.verify(token ?? "", ACCESS_SECRET);
    if (payload.scope !== "access") throw new Error("scope");
    userId = payload.sub;
  } catch {
    ws.close(4001, "Token invalide");
    return;
  }

  ws.userId = userId;
  ws.isAlive = true;
  addClient(userId, ws);
  ws.send(JSON.stringify({ type: "ready" }));

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      if (msg.type === "send") await handleSend(ws, msg);
      else if (msg.type === "read") await handleRead(ws, msg);
      else if (msg.type === "typing") await handleTyping(ws, msg);
      else if (msg.type === "call_ring") await handleCallRing(ws, msg);
      else if (msg.type === "call_signal") await handleCallSignal(ws, msg);
      else if (msg.type === "call_state") await handleCallState(ws, msg);
    } catch (e) {
      console.error("[ws] erreur de traitement:", e);
      ws.send(JSON.stringify({ type: "error", message: "Erreur serveur", tempId: msg?.tempId }));
    }
  });

  ws.on("close", () => removeClient(userId, ws));
  ws.on("error", () => removeClient(userId, ws));
});

// Heartbeat : ferme les connexions mortes.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

wss.on("close", () => clearInterval(heartbeat));

process.on("SIGINT", async () => {
  clearInterval(heartbeat);
  await prisma.$disconnect();
  process.exit(0);
});
