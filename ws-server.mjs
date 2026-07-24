// Serveur WebSocket temps réel d'Alanya (process séparé du serveur Next.js).
// - Authentifie chaque connexion via le JWT d'accès (?token=...).
// - Reçoit les messages, les persiste (Prisma) puis les diffuse aux participants.
// - Gère les accusés de lecture et l'indicateur « est en train d'écrire ».
//
// Lancement : npm run ws (équivaut à `node --env-file=.env ws-server.mjs`)
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

// userId -> Set<ws>
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
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) return true;
  }
  return false;
}

// FIX: buffer des trames "incoming_call" non délivrées.
const pendingCalls = new Map();

function bufferPendingCall(userId, payload) {
  const list = pendingCalls.get(userId) ?? [];
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

// ═══════════════════════════════════════════════
// SERIALIZE MESSAGE — modifié pour inclure médias dans replyTo
// ═══════════════════════════════════════════════
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

  // MODIFICATION : inclut les médias du message cité pour le preview reply
  if (m.replyToId) {
    const target = await prisma.message.findUnique({
      where: { id: m.replyToId },
      select: { senderId: true, content: true, type: true, deletedAt: true, media: true },
    });
    if (target) {
      base.replyTo = {
        id: m.replyToId,
        senderId: target.senderId,
        type: target.type,
        content: target.deletedAt ? null : target.content,
        isDeleted: target.deletedAt !== null,
        media: (target.media ?? []).slice(0, 1).map((f) => ({
          id: f.id,
          url: `/api/media/${f.id}`,
          filename: f.filename,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          durationMs: f.durationMs,
        })),
      };
    }
  }

  return base;
}

// ═══════════════════════════════════════════════
// HANDLE SEND — modifié pour supporter mediaIds (multiple)
// ═══════════════════════════════════════════════
async function handleSend(ws, msg) {
  // MODIFICATION : ajoute mediaIds pour multi-médias
  const { convId, content, tempId, mediaId, mediaIds } = msg;
  const type = msg.msgType ?? "TEXT";
  if (!convId) return;
  if (type === "TEXT" && (!content || !content.trim())) return;

  // MODIFICATION : collecte tous les media IDs (simple + multiple)
  const allMediaIds = [];
  if (mediaId) allMediaIds.push(mediaId);
  if (Array.isArray(mediaIds)) allMediaIds.push(...mediaIds);
  const uniqueMediaIds = [...new Set(allMediaIds)];

  if (type !== "TEXT" && uniqueMediaIds.length === 0) return;

  if (!(await isParticipant(convId, ws.userId))) {
    ws.send(JSON.stringify({ type: "error", message: "Conversation interdite", tempId }));
    return;
  }

  // MODIFICATION : vérifie tous les médias
  for (const mid of uniqueMediaIds) {
    const m = await prisma.mediaFile.findUnique({ where: { id: mid }, select: { ownerId: true } });
    if (!m || m.ownerId !== ws.userId) {
      ws.send(JSON.stringify({ type: "error", message: "Media invalide", tempId }));
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
      // MODIFICATION : connecte plusieurs médias
      ...(uniqueMediaIds.length > 0
        ? { media: { connect: uniqueMediaIds.map((id) => ({ id })) } }
        : {}),
    },
    include: { media: true },
  });

  // F10 + F11 : met à jour le dernier message dénormalisé + incrémente unreadCount
  await prisma.conversation.update({
    where: { id: convId },
    data: {
      lastMessage: content?.slice(0, 500) ?? null,
      lastMessageAt: new Date(),
      lastMessageSenderID: ws.userId,
      lastMessageType: type === "TEXT" ? 0 : type === "IMAGE" ? 1 : type === "AUDIO" ? 3 : type === "VIDEO" ? 4 : 2,
      lastMessageStatus: 0,
    },
  });
  // Incrémente unreadCount pour tous les autres participants
  await prisma.participant.updateMany({
    where: { convId, userId: { not: ws.userId } },
    data: { unreadCount: { increment: 1 } },
  });

  const serialized = await serializeMessage(created, created.media);
  const recipients = await participantsOf(convId);

  const otherOnline = recipients.some(
    (uid) => uid !== ws.userId && isUserOnline(uid),
  );
  let finalStatus = created.status;
  if (otherOnline) {
    await prisma.message.update({ where: { id: created.id }, data: { status: "DELIVERED" } });
    finalStatus = "DELIVERED";
  }

  const messageWithStatus = { ...serialized, status: finalStatus };
  for (const uid of recipients) {
    sendTo(uid, {
      type: "message",
      message: messageWithStatus,
      tempId: uid === ws.userId ? tempId : undefined,
    });
  }

  if (isPushEnabled()) {
    const sender = await prisma.user.findUnique({
      where: { id: ws.userId },
    });
    const senderName = sender?.pseudo ?? sender?.publicNumber ?? "Quelqu'un";
    const conv = await prisma.conversation.findUnique({
      where: { id: convId },
      include: { participants: { include: { user: true } } },
    });
    let convTitle = conv?.name ?? null;
    if (conv && !conv.isGroup) {
      const other = conv.participants.find((p) => p.userId !== ws.userId);
      convTitle = other?.user.pseudo ?? other?.user.publicNumber ?? convTitle;
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
    data: { lastReadAt: now, unreadCount: 0 },
  });

  const updated = await prisma.message.updateMany({
    where: {
      convId,
      senderId: { not: ws.userId },
      status: { not: "READ" },
    },
    data: { status: "READ" },
  });

  const recipients = await participantsOf(convId);
  for (const uid of recipients) {
    if (uid === ws.userId) continue;
    sendTo(uid, { type: "read", convId, userId: ws.userId, at: now });
    if (updated.count > 0) {
      sendTo(uid, { type: "message_status", convId, status: "READ", userId: ws.userId });
    }
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

async function handleCallRing(ws, msg) {
  const { callId } = msg;
  if (!callId) return;

  let call = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    call = await prisma.call.findUnique({
      where: { id: callId },
      include: { initiator: true },
    });
    if (call) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!call) return;
  if (call.initiatorId !== ws.userId) return;
  if (call.status !== "RINGING") return;

  const callerName = call.initiator.pseudo ?? call.initiator.publicNumber;
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
    if (!delivered) {
      bufferPendingCall(uid, payload);
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
}

async function handleCallSignal(ws, msg) {
  const { callId, toUserId, signal } = msg;
  if (!callId || !toUserId || !signal) return;
  const ids = await callParticipantIds(callId);
  if (!ids.includes(ws.userId) || !ids.includes(toUserId)) return;
  sendTo(toUserId, { type: "call_signal", callId, from: ws.userId, signal });
}

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
    sendTo(uid, payload);
  }
}

// Invite un nouvel utilisateur dans un appel EN COURS (transfert / ajout groupe).
// Ajoute l'invité aux participants et lui envoie un incoming_call ; informe les
// participants existants de l'identité de l'invité (call_state "inviting").
// Purement additif : n'affecte aucun flux d'appel existant.
async function handleCallInvite(ws, msg) {
  const { callId, publicNumber } = msg;
  if (!callId || !publicNumber) return;

  // Le demandeur doit lui-même être participant de l'appel.
  const ids = await callParticipantIds(callId);
  if (!ids.includes(ws.userId)) return;

  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call || (call.status !== "RINGING" && call.status !== "ONGOING")) return;

  const invitee = await prisma.user.findUnique({ where: { publicNumber } });
  if (!invitee) {
    ws.send(JSON.stringify({ type: "call_invite_result", ok: false, reason: "NOT_FOUND", publicNumber }));
    return;
  }
  if (invitee.id === ws.userId || ids.includes(invitee.id)) {
    ws.send(JSON.stringify({ type: "call_invite_result", ok: false, reason: "ALREADY_IN", publicNumber }));
    return;
  }

  // Ajoute l'invité aux participants (pas encore "joined").
  await prisma.callParticipant.upsert({
    where: { callId_userId: { callId, userId: invitee.id } },
    update: { leftAt: null },
    create: { callId, userId: invitee.id, joinedAt: null },
  });

  // Fait sonner l'invité (même charge utile que handleCallRing).
  const inviter = await prisma.user.findUnique({ where: { id: ws.userId } });
  const callerName = inviter?.pseudo ?? inviter?.publicNumber ?? "Quelqu'un";
  let groupName = null;
  let memberCount = 0;
  if (call.convId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: call.convId },
      include: { participants: true },
    });
    groupName = conv?.name ?? null;
    memberCount = conv?.participants.length ?? 0;
  }
  sendTo(invitee.id, {
    type: "incoming_call",
    callId,
    convId: call.convId,
    callType: call.type,
    callerId: ws.userId,
    callerName,
    isGroup: true, // multi-partie tant que l'invité rejoint
    groupName,
    memberCount: memberCount + 1,
  });

  // Informe l'inviteur ET les autres participants de l'identité de l'invité.
  const payload = {
    type: "call_state",
    callId,
    state: "inviting",
    from: ws.userId,
    userId: invitee.id,
    displayName: invitee.pseudo ?? invitee.publicNumber ?? null,
  };
  for (const uid of ids) sendTo(uid, payload);
  ws.send(JSON.stringify({ type: "call_invite_result", ok: true, userId: invitee.id, publicNumber }));
}

async function handleDeleteMessage(ws, msg) {
  const { messageId, scope } = msg;
  if (!messageId) return;

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) {
    ws.send(JSON.stringify({ type: "error", message: "Message introuvable" }));
    return;
  }

  if (!(await isParticipant(message.convId, ws.userId))) return;

  if (scope === "everyone") {
    if (message.senderId !== ws.userId) {
      ws.send(JSON.stringify({ type: "error", message: "Seul l'expéditeur peut supprimer pour tous" }));
      return;
    }
    await prisma.message.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), content: null },
    });
    await prisma.mediaFile.updateMany({
      where: { messageId },
      data: { messageId: null },
    });

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
    await prisma.messageHide.upsert({
      where: { userId_messageId: { userId: ws.userId, messageId } },
      create: { userId: ws.userId, messageId },
      update: {},
    });
    sendTo(ws.userId, {
      type: "message_deleted",
      messageId,
      convId: message.convId,
      scope: "me",
    });
  }
}

async function handleForwardMessage(ws, msg) {
  const { messageId, targetConvIds } = msg;
  if (!messageId || !Array.isArray(targetConvIds) || targetConvIds.length === 0) return;

  const original = await prisma.message.findUnique({
    where: { id: messageId },
    include: { media: true },
  });
  if (!original || original.deletedAt) return;

  if (!(await isParticipant(original.convId, ws.userId))) return;

  const results = [];
  for (const targetConvId of targetConvIds) {
    if (!(await isParticipant(targetConvId, ws.userId))) continue;

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

    const serialized = await serializeMessage(created, created.media);
    const recipients = await participantsOf(targetConvId);
    for (const uid of recipients) {
      sendTo(uid, { type: "message", message: serialized });
    }

    results.push({ convId: targetConvId, messageId: created.id });
  }

  sendTo(ws.userId, { type: "forwarded", results });
}

// ---------------------------------------------------------------------------
// MEETINGS — salles de réunion (Google Meet style)
// ---------------------------------------------------------------------------

const meetingRooms = new Map();

function meetingParticipants(meetingId) {
  const room = meetingRooms.get(meetingId);
  return room ? [...room.keys()] : [];
}

function sendToMeeting(meetingId, payload, excludeUserId) {
  const room = meetingRooms.get(meetingId);
  if (!room) return;
  const data = JSON.stringify(payload);
  for (const [uid, ws] of room) {
    if (uid === excludeUserId) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

async function handleMeetingJoin(ws, msg) {
  const { meetingId } = msg;
  if (!meetingId) return;

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: meetingId },
    select: { idMeeting: true, isEnd: true, idOrganiser: true },
  });
  if (!meeting) {
    ws.send(JSON.stringify({ type: "error", message: "Réunion introuvable", meetingId }));
    return;
  }
  if (meeting.isEnd === 1) {
    ws.send(JSON.stringify({ type: "error", message: "Cette réunion est terminée", meetingId }));
    return;
  }

  const participant = await prisma.meetingParticipant.findUnique({
    where: { idMeeting_IDparticipant: { idMeeting: meetingId, IDparticipant: ws.userId } },
  });
  if (participant) {
    await prisma.meetingParticipant.update({
      where: { ID: participant.ID },
      data: { status: 1, connecte: 1, start_time: new Date() },
    });
  } else {
    if (meeting.idOrganiser !== ws.userId) {
      ws.send(JSON.stringify({ type: "error", message: "Vous n'êtes pas invité", meetingId }));
      return;
    }
    await prisma.meetingParticipant.create({
      data: { idMeeting: meetingId, IDparticipant: ws.userId, status: 1, connecte: 1, start_time: new Date() },
    });
  }

  if (!meetingRooms.has(meetingId)) meetingRooms.set(meetingId, new Map());
  meetingRooms.get(meetingId).set(ws.userId, ws);

  const user = await prisma.user.findUnique({ where: { id: ws.userId }, select: { pseudo: true, publicNumber: true } });
  const displayName = user?.pseudo ?? user?.publicNumber ?? "Participant";
  const existing = meetingParticipants(meetingId);

  ws.send(JSON.stringify({
    type: "meeting_joined",
    meetingId,
    participants: existing.filter((id) => id !== ws.userId),
  }));

  sendToMeeting(meetingId, {
    type: "meeting_user_joined",
    meetingId,
    userId: ws.userId,
    displayName,
  }, ws.userId);
}

async function handleMeetingLeave(ws, msg) {
  const { meetingId } = msg;
  if (!meetingId) return;

  const room = meetingRooms.get(meetingId);
  if (room) {
    room.delete(ws.userId);
    if (room.size === 0) meetingRooms.delete(meetingId);
  }

  const participant = await prisma.meetingParticipant.findUnique({
    where: { idMeeting_IDparticipant: { idMeeting: meetingId, IDparticipant: ws.userId } },
  });
  if (participant) {
    const duree = participant.start_time
      ? Math.round((Date.now() - participant.start_time.getTime()) / 1000)
      : null;
    await prisma.meetingParticipant.update({
      where: { ID: participant.ID },
      data: { connecte: 0, duree },
    });
  }

  sendToMeeting(meetingId, {
    type: "meeting_user_left",
    meetingId,
    userId: ws.userId,
  }, ws.userId);
}

async function handleMeetingSignal(ws, msg) {
  const { meetingId, toUserId, signal } = msg;
  if (!meetingId || !toUserId || !signal) return;

  const room = meetingRooms.get(meetingId);
  if (!room || !room.has(ws.userId)) return;

  const targetWs = room.get(toUserId);
  if (targetWs && targetWs.readyState === targetWs.OPEN) {
    targetWs.send(JSON.stringify({
      type: "meeting_signal",
      meetingId,
      fromUserId: ws.userId,
      signal,
    }));
  }
}

const wss = new WebSocketServer({ port: PORT });

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[ws] Le port ${PORT} est déjà utilisé.`);
  } else {
    console.error("[ws] Erreur serveur:", err);
  }
  process.exit(1);
});

wss.on("listening", () => {
  console.log(`[ws] Serveur WebSocket Alanya à l'écoute sur ws://localhost:${PORT}`);
});

wss.on("connection", (ws, req) => {
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
      else if (msg.type === "call_invite") await handleCallInvite(ws, msg);
      else if (msg.type === "delete_message") await handleDeleteMessage(ws, msg);
      else if (msg.type === "forward_message") await handleForwardMessage(ws, msg);
      else if (msg.type === "meeting_join") await handleMeetingJoin(ws, msg);
      else if (msg.type === "meeting_leave") await handleMeetingLeave(ws, msg);
      else if (msg.type === "meeting_signal") await handleMeetingSignal(ws, msg);
    } catch (e) {
      console.error("[ws] erreur de traitement:", e);
      ws.send(JSON.stringify({ type: "error", message: "Erreur serveur", tempId: msg?.tempId }));
    }
  });

  ws.on("close", () => {
    removeClient(userId, ws);
    for (const [meetingId, room] of meetingRooms) {
      if (room.has(userId)) {
        room.delete(userId);
        if (room.size === 0) meetingRooms.delete(meetingId);
        sendToMeeting(meetingId, {
          type: "meeting_user_left",
          meetingId,
          userId,
        }, userId);
      }
    }
  });
  ws.on("error", () => removeClient(userId, ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
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
