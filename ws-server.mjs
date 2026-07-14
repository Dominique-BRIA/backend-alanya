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
  if (!set) return false;
  const data = JSON.stringify(payload);
  let delivered = false;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      delivered = true;
    }
  }
  return delivered;
}

function isUserOnline(userId) {
  const set = clients.get(userId);
  if (!set) return false;
  // FIX: ne compter QUE les sockets réellement OPEN.
  // Sinon isUserOnline peut renvoyer true pour un socket zombie
  // (readyState=2 CLOSING ou 3 CLOSED) pas encore nettoyé par le heartbeat.
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) return true;
  }
  return false;
}

// FIX: buffer des trames "incoming_call" non délivrées.
// Sur mobile 4G/VPN les sockets tombent régulièrement (errno 103 ECONNABORTED).
// Si le serveur envoie incoming_call pendant que B est en train de reconnecter,
// la trame est perdue. On la rejoue à la reconnexion tant que l'appel est RINGING.
// Map: userId -> Array<{payload, expiresAt}>
const pendingCalls = new Map();

function bufferPendingCall(userId, payload) {
  const list = pendingCalls.get(userId) ?? [];
  // TTL 60s (durée max d'une sonnerie).
  list.push({ payload, expiresAt: Date.now() + 60_000 });
  pendingCalls.set(userId, list);
}

async function flushPendingCalls(userId, ws) {
  const list = pendingCalls.get(userId);
  if (!list?.length) return;
  const now = Date.now();
  const stillValid = [];
  for (const { payload, expiresAt } of list) {
    if (expiresAt < now) continue;
    // Vérifie que l'appel est encore en RINGING avant de rejouer.
    try {
      const call = await prisma.call.findUnique({
        where: { id: payload.callId },
        select: { status: true },
      });
      if (call?.status !== "RINGING") continue;
    } catch {
      continue;
    }
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
      console.log(`[replay] 🔁 incoming_call rejoué à ${userId} callId=${payload.callId}`);
    } else {
      stillValid.push({ payload, expiresAt });
    }
  }
  if (stillValid.length) pendingCalls.set(userId, stillValid);
  else pendingCalls.delete(userId);
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

// Sérialise un message pour l'envoi WebSocket. Inclut un snapshot du message
// cité (replyTo) si le message est une réponse — permet à l'UI d'afficher
// l'aperçu même si le message original n'est plus chargé en mémoire locale.
async function serializeMessage(m, media) {
  const base = {
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

  // Si ce message est une réponse, on inclut un snapshot du message cité.
  if (m.replyToId) {
    const target = await prisma.message.findUnique({
      where: { id: m.replyToId },
      select: { senderId: true, content: true, type: true, deletedAt: true },
    });
    if (target) {
      base.replyTo = {
        id: m.replyToId,
        senderId: target.senderId,
        type: target.type,
        content: target.deletedAt ? null : target.content,
        isDeleted: target.deletedAt !== null,
      };
    }
  }

  return base;
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

  const serialized = await serializeMessage(created, created.media);
  const recipients = await participantsOf(convId);

  // --- Statut DELIVERED ---
  // Si au moins un autre participant est en ligne, le message est « reçu » :
  // on passe le statut de SENT à DELIVERED et on notifie l'expéditeur.
  const otherOnline = recipients.some(
    (uid) => uid !== ws.userId && isUserOnline(uid),
  );
  let finalStatus = created.status; // "SENT"
  if (otherOnline) {
    await prisma.message.update({ where: { id: created.id }, data: { status: "DELIVERED" } });
    finalStatus = "DELIVERED";
  }

  // On diffuse le message (avec le statut potentiellement mis à jour) à tous les participants.
  const messageWithStatus = { ...serialized, status: finalStatus };
  for (const uid of recipients) {
    // On renvoie le tempId uniquement à l'expéditeur pour réconcilier l'optimiste.
    sendTo(uid, {
      type: "message",
      message: messageWithStatus,
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
  console.log(`[call_ring] ⬇️ reçu de user=${ws.userId} callId=${callId}`);
  if (!callId) {
    console.warn(`[call_ring] ❌ callId manquant`);
    return;
  }

  // FIX race Vercel↔Render : le POST /api/calls vient d'être fait sur Vercel,
  // mais la ligne peut ne pas être encore visible côté Render (pooler / replica lag).
  // On retente la lecture jusqu'à 5 fois avec 200ms d'attente.
  let call = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    call = await prisma.call.findUnique({
      where: { id: callId },
      include: { initiator: { include: { profile: true } } },
    });
    if (call) break;
    console.warn(`[call_ring] ⏳ call introuvable (tentative ${attempt + 1}/5), retry dans 200ms`);
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!call) {
    console.error(`[call_ring] ❌ ABANDON: call ${callId} introuvable après 5 tentatives`);
    ws.send(JSON.stringify({ type: "error", message: "Appel introuvable", callId }));
    return;
  }
  if (call.initiatorId !== ws.userId) {
    console.error(`[call_ring] ❌ ABANDON: initiatorId=${call.initiatorId} != ws.userId=${ws.userId}`);
    return;
  }
  if (call.status !== "RINGING") {
    console.error(`[call_ring] ❌ ABANDON: status=${call.status} (attendu RINGING)`);
    return;
  }

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
  console.log(`[call_ring] 🎯 cibles=${JSON.stringify(targets)} (émetteur exclu)`);
  for (const uid of targets) {
    if (uid === ws.userId) continue;
    const payload = {
      type: "incoming_call",
      callId,
      convId: call.convId,
      callType: call.type,
      callerId: ws.userId,
      callerName,
      isGroup,
      groupName,
      memberCount,
    };
    const delivered = sendTo(uid, payload);
    console.log(`[call_ring] → envoi incoming_call à ${uid} (delivered=${delivered})`);
    if (!delivered) {
      // Buffer pour rejouer à la reconnexion (cas typique mobile 4G qui drop).
      bufferPendingCall(uid, payload);
      console.log(`[call_ring] 💾 bufferisé pour rejeu (${uid})`);
    }
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
  console.log(`[call_ring] ✅ terminé pour callId=${callId}`);
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

// Suppression de message : « pour moi » (masque localement) ou « pour tous »
// (efface le contenu + détache les médias, visible par tous comme supprimé).
async function handleDeleteMessage(ws, msg) {
  const { messageId, scope } = msg;
  if (!messageId) return;

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) {
    ws.send(JSON.stringify({ type: "error", message: "Message introuvable" }));
    return;
  }

  // L'utilisateur doit participer à la conversation du message.
  if (!(await isParticipant(message.convId, ws.userId))) return;

  if (scope === "everyone") {
    // Seul l'expéditeur peut supprimer pour tout le monde.
    if (message.senderId !== ws.userId) {
      ws.send(JSON.stringify({ type: "error", message: "Seul l'expéditeur peut supprimer pour tous" }));
      return;
    }
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: null },
    });
    // Détache les médias du message (ils restent en base mais ne sont plus liés).
    await prisma.mediaFile.updateMany({
      where: { messageId },
      data: { messageId: null },
    });

    // Notifie TOUS les participants (y compris l'expéditeur pour confirmer).
    const recipients = await participantsOf(message.convId);
    for (const uid of recipients) {
      sendTo(uid, {
        type: "message_deleted",
        messageId,
        convId: message.convId,
        scope: "everyone",
      });
    }
  } else {
    // « Pour moi » : masque le message pour cet utilisateur uniquement.
    await prisma.messageHide.upsert({
      where: { userId_messageId: { userId: ws.userId, messageId } },
      create: { userId: ws.userId, messageId },
      update: {},
    });
    // Confirme uniquement à l'expéditeur (les autres ne voient aucun changement).
    sendTo(ws.userId, {
      type: "message_deleted",
      messageId,
      convId: message.convId,
      scope: "me",
    });
  }
}

// Transfert d'un message vers une ou plusieurs conversations cibles.
// Copie le contenu + les médias (sans re-téléverser les binaires).
async function handleForwardMessage(ws, msg) {
  const { messageId, targetConvIds } = msg;
  if (!messageId || !Array.isArray(targetConvIds) || targetConvIds.length === 0) return;

  const original = await prisma.message.findUnique({
    where: { id: messageId },
    include: { media: true },
  });
  if (!original || original.deletedAt) return;

  // L'utilisateur doit participer à la conversation source.
  if (!(await isParticipant(original.convId, ws.userId))) return;

  const results = [];
  for (const targetConvId of targetConvIds) {
    if (!(await isParticipant(targetConvId, ws.userId))) continue;

    // Copie les médias (nouvelles entrées pointant vers le même binaire).
    const mediaIds = [];
    for (const m of original.media) {
      const copy = await prisma.mediaFile.create({
        data: {
          ownerId: ws.userId,
          filename: m.filename,
          mimeType: m.mimeType,
          sizeBytes: m.sizeBytes,
          url: m.url,
          durationMs: m.durationMs,
        },
      });
      mediaIds.push(copy.id);
    }

    const created = await prisma.message.create({
      data: {
        convId: targetConvId,
        senderId: ws.userId,
        content: original.content,
        type: original.type,
        status: "SENT",
        ...(mediaIds.length > 0 ? { media: { connect: mediaIds.map((id) => ({ id })) } } : {}),
      },
      include: { media: true },
    });

    await prisma.conversation.update({
      where: { id: targetConvId },
      data: { updatedAt: new Date() },
    });

    // Diffuse le nouveau message aux participants de la conversation cible.
    const serialized = await serializeMessage(created, created.media);
    const recipients = await participantsOf(targetConvId);
    for (const uid of recipients) {
      sendTo(uid, { type: "message", message: serialized });
    }

    results.push({ convId: targetConvId, messageId: created.id });
  }

  // Confirme le résultat à l'expéditeur.
  sendTo(ws.userId, { type: "forwarded", results });
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

  // FIX: rejoue les incoming_call bufferisés pendant une éventuelle déconnexion.
  // Indispensable pour les réseaux mobiles instables (4G Cameroun/VPN Render).
  flushPendingCalls(userId, ws).catch((e) =>
    console.error(`[replay] erreur flush pour ${userId}:`, e),
  );

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
      else if (msg.type === "delete_message") await handleDeleteMessage(ws, msg);
      else if (msg.type === "forward_message") await handleForwardMessage(ws, msg);
    } catch (e) {
      console.error("[ws] erreur de traitement:", e);
      ws.send(JSON.stringify({ type: "error", message: "Erreur serveur", tempId: msg?.tempId }));
    }
  });

  ws.on("close", () => removeClient(userId, ws));
  ws.on("error", () => removeClient(userId, ws));
});

// Heartbeat : ferme les connexions mortes.
// FIX: intervalle réduit de 30s → 10s pour détecter plus vite les sockets
// zombies (mobile 4G qui drop mais dont le TCP RST n'arrive pas au serveur).
// Sans ça, isUserOnline peut renvoyer true pendant jusqu'à 60s après une
// coupure réelle, et incoming_call est écrit dans le vide.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.log(`[hb] terminate zombie user=${ws.userId}`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 10_000);

wss.on("close", () => clearInterval(heartbeat));

process.on("SIGINT", async () => {
  clearInterval(heartbeat);
  await prisma.$disconnect();
  process.exit(0);
});
