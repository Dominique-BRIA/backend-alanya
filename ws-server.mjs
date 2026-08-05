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
import { isPushEnabled, pushIncomingCall, pushNewMessage, pushCallCancelled } from "./push.mjs";
// Mêmes règles de libellé que l'API HTTP — voir l'en-tête de ce fichier pour la
// raison du JavaScript plutôt que du TypeScript.
import {
  serialiseAppelPour,
  STATUTS_TERMINAUX,
  DELAI_SANS_REPONSE_MS,
} from "./src/lib/call-labels.mjs";
import { nomAffichage } from "./src/lib/display-name.mjs";

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

// Blocage (source de vérité : table Blocked). Deux personnes sont bloquées si
// l'une a bloqué l'autre → on ne délivre plus messages/appels entre elles.
async function areBlocked(userA, userB) {
  const row = await prisma.blocked.findFirst({
    where: {
      OR: [
        { alanyaID: userA, idCallerBlock: userB },
        { alanyaID: userB, idCallerBlock: userA },
      ],
    },
    select: { idBlock: true },
  });
  return row !== null;
}

// Personnes qui partagent au moins une conversation avec `userId` (= celles qui
// voient sa présence dans l'app). Cible de la diffusion temps réel.
async function conversationPeers(userId) {
  const myConvs = await prisma.participant.findMany({
    where: { userId },
    select: { convId: true },
  });
  const convIds = myConvs.map((p) => p.convId);
  if (convIds.length === 0) return [];
  const peers = await prisma.participant.findMany({
    where: { convId: { in: convIds }, userId: { not: userId } },
    select: { userId: true },
    distinct: ["userId"],
  });
  return peers.map((p) => p.userId);
}

// Présence fiable : met à jour User.isOnline (+ lastSeen à la déconnexion) ET la
// DIFFUSE en temps réel (event WS `presence`) aux personnes qui partagent une
// conversation → remplace le polling toutes les 5 s côté app.
// Auparavant isOnline n'était touché qu'au login/logout REST → un crash / kill
// de l'app laissait l'utilisateur « en ligne » indéfiniment.
async function announcePresence(userId, online) {
  let lastSeen = null;
  let visibility = 2;
  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: online ? { isOnline: 1 } : { isOnline: 0, lastSeen: new Date() },
      select: { lastSeen: true, lastSeenVisibility: true },
    });
    lastSeen = updated.lastSeen;
    visibility = updated.lastSeenVisibility;
  } catch {
    return; // Utilisateur supprimé / course au démarrage : non bloquant.
  }
  // Confidentialité : « personne » (0) → on n'annonce pas la présence.
  if (visibility === 0) return;
  try {
    const payload = {
      type: "presence",
      userId,
      isOnline: online ? 1 : 0,
      lastSeen: lastSeen ? lastSeen.toISOString() : null,
    };
    for (const uid of await conversationPeers(userId)) {
      if (isUserOnline(uid)) sendTo(uid, payload);
    }
  } catch (e) {
    console.error("[ws] diffusion présence:", e);
  }
}

// À la connexion : envoie à l'utilisateur l'état EN LIGNE de ses interlocuteurs
// déjà connectés, pour que son UI soit correcte immédiatement (sans attendre
// qu'un contact change d'état).
async function sendPresenceSnapshot(userId, ws) {
  try {
    const peers = await conversationPeers(userId);
    if (peers.length === 0) return;
    // Confidentialité : n'inclut que les pairs qui n'ont pas masqué leur présence.
    const visible = await prisma.user.findMany({
      where: { id: { in: peers }, lastSeenVisibility: { not: 0 } },
      select: { id: true },
    });
    const visibleIds = new Set(visible.map((u) => u.id));
    for (const uid of peers) {
      if (visibleIds.has(uid) && isUserOnline(uid)) {
        ws.send(
          JSON.stringify({ type: "presence", userId: uid, isOnline: 1, lastSeen: null }),
        );
      }
    }
  } catch (e) {
    console.error("[ws] snapshot présence:", e);
  }
}

// À appeler quand une socket disparaît (close/error). Passe l'utilisateur
// hors-ligne uniquement si PLUS AUCUNE de ses sockets n'est ouverte (multi-device).
function markOfflineIfGone(userId, ws) {
  removeClient(userId, ws);
  if (!clients.has(userId)) {
    announcePresence(userId, false).catch(() => {});
    // Dernière socket fermée : ses appels en cours n'ont plus personne pour
    // les porter. Sans cela, l'appel restait en sonnerie et son correspondant
    // était considéré comme occupé indéfiniment.
    clotureAppelsDeLUtilisateur(userId).catch(() => {});
  }
}

// Purge des statuts (stories) expirés. Avant, ils étaient seulement masqués à la
// lecture (expiresAt > now) mais jamais supprimés → accumulation infinie en base.
// Les StatusView associées partent en cascade (onDelete: Cascade).
// NB : les binaires média des statuts (Status.mediaUrl → MediaFile) ne sont pas
// nettoyés ici — ce serait un GC média séparé.
async function purgeExpiredStatuses() {
  try {
    const res = await prisma.status.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (res.count > 0) console.log(`[ws] Statuts expirés purgés : ${res.count}`);
  } catch (e) {
    console.error("[ws] purge des statuts expirés:", e);
  }
  // Messages éphémères arrivés à expiration → suppression définitive.
  try {
    const res = await prisma.message.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (res.count > 0) console.log(`[ws] Messages éphémères purgés : ${res.count}`);
  } catch (e) {
    console.error("[ws] purge des messages éphémères:", e);
  }
}

/**
 * Ferme les appels laissés en sonnerie au-delà du délai.
 *
 * ⚠️ CE BALAYAGE EST INDISPENSABLE, et son absence était le défaut le plus
 * grave du système d'appel. Le seul nettoyage existant vit dans
 * `POST /api/calls` : il ne s'exécute donc QUE lorsque quelqu'un passe un
 * nouvel appel, et uniquement sur SES propres appels.
 *
 * Conséquence : si l'appelant plante ou perd le réseau sans raccrocher, l'appel
 * restait RINGING indéfiniment. Son correspondant était alors considéré comme
 * occupé — donc INJOIGNABLE pour tout le monde, sans limite de temps et sans
 * que rien ne l'indique.
 *
 * Le nettoyage ne doit dépendre de l'activité de personne : il tourne ici, à
 * intervalle régulier, pour tous les utilisateurs.
 */
async function fermeAppelsPerimes() {
  try {
    const limite = new Date(Date.now() - DELAI_SANS_REPONSE_MS);
    const perimes = await prisma.call.findMany({
      where: { status: "RINGING", startedAt: { lt: limite } },
      select: { id: true },
    });
    if (perimes.length === 0) return;
    const ids = perimes.map((c) => c.id);
    const maintenant = new Date();
    await prisma.call.updateMany({
      where: { id: { in: ids } },
      data: { status: "NO_ANSWER", endedAt: maintenant },
    });
    await prisma.callParticipant.updateMany({
      where: { callId: { in: ids }, leftAt: null },
      data: { leftAt: maintenant },
    });
    console.log(`[ws] Appels sans réponse clôturés : ${ids.length}`);
    // Chacun doit l'apprendre : sans cette diffusion, l'écran d'appel de
    // l'appelant continuerait de sonner alors que l'appel est clos en base.
    for (const id of ids) {
      const participants = await callParticipantIds(id);
      for (const uid of participants) {
        sendTo(uid, { type: "call_state", callId: id, state: "ended", from: null });
      }
      await diffuseAppelTermine(id, participants);
      if (isPushEnabled()) {
        for (const uid of participants) {
          pushCallCancelled(prisma, { recipientId: uid, callId: id }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error("[ws] clôture des appels périmés:", e);
  }
}

/**
 * Clôt les appels d'un utilisateur dont la dernière socket vient de se fermer.
 *
 * Complète le balayage périodique en réagissant TOUT DE SUITE : quand
 * l'application de l'appelant est tuée, son correspondant n'a aucune raison
 * d'attendre 90 s avant que la sonnerie ne s'arrête.
 */
async function clotureAppelsDeLUtilisateur(userId) {
  try {
    const parts = await prisma.callParticipant.findMany({
      where: {
        userId,
        leftAt: null,
        call: { status: { in: ["RINGING", "ONGOING"] } },
      },
      include: { call: { select: { id: true, status: true, initiatorId: true, answeredAt: true } } },
    });
    if (parts.length === 0) return;
    const maintenant = new Date();

    for (const p of parts) {
      const appel = p.call;
      const participants = await callParticipantIds(appel.id);

      // Sonnerie dont l'initiateur disparaît : plus personne ne peut décrocher,
      // l'appel est clos pour tout le monde.
      const estInitiateur = appel.initiatorId === userId;
      const doitClore =
        (appel.status === "RINGING" && estInitiateur) ||
        // Sinon, on ne retire QUE cet utilisateur ; l'appel ne se clôt que s'il
        // ne reste personne en ligne — même règle que la route `leave`.
        false;

      await prisma.callParticipant.updateMany({
        where: { callId: appel.id, userId },
        data: { leftAt: maintenant },
      });

      let clos = doitClore;
      if (!doitClore) {
        const restants = await prisma.callParticipant.count({
          where: { callId: appel.id, joinedAt: { not: null }, leftAt: null },
        });
        clos = restants === 0;
      }
      if (!clos) continue;

      await prisma.call.update({
        where: { id: appel.id },
        data: {
          status: appel.answeredAt ? "ENDED" : "NO_ANSWER",
          endedAt: maintenant,
        },
      });
      await prisma.callParticipant.updateMany({
        where: { callId: appel.id, leftAt: null },
        data: { leftAt: maintenant },
      });
      for (const uid of participants) {
        if (uid === userId) continue;
        sendTo(uid, { type: "call_state", callId: appel.id, state: "ended", from: userId });
      }
      await diffuseAppelTermine(appel.id, participants);
      if (isPushEnabled()) {
        for (const uid of participants) {
          if (uid === userId) continue;
          pushCallCancelled(prisma, { recipientId: uid, callId: appel.id }).catch(() => {});
        }
      }
      console.log(`[ws] Appel ${appel.id} clos : socket de ${userId} fermée`);
    }
  } catch (e) {
    console.error("[ws] clôture des appels à la déconnexion:", e);
  }
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
    // Réactions brutes { userId, emoji } ; le client agrège et repère les siennes.
    reactions: (m.reactions ?? []).map((r) => ({ userId: r.userId, emoji: r.emoji })),
    createdAt: m.createdAt,
    editedAt: m.editedAt ?? null,
    expiresAt: m.expiresAt ?? null,
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
/// Déduit le type d'un message à partir du MIME de son premier média.
///
/// Le type était jusqu'ici pris tel quel du client. Le client web omettait
/// « video » dans sa table de conversion : une vidéo partait donc étiquetée
/// TEXT, et le mobile affichait « [TEXT] » au lieu du lecteur. Le serveur est
/// le seul point commun aux trois clients — c'est ici que la règle tient.
function typeDepuisMime(mime) {
  if (!mime) return "FILE";
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("video/")) return "VIDEO";
  if (mime.startsWith("audio/")) return "AUDIO";
  return "FILE";
}

async function handleSend(ws, msg) {
  // MODIFICATION : ajoute mediaIds pour multi-médias
  const { convId, content, tempId, mediaId, mediaIds } = msg;
  let type = msg.msgType ?? "TEXT";
  if (!convId) return;

  // MODIFICATION : collecte tous les media IDs (simple + multiple)
  // Déplacée AVANT le contrôle du TEXT vide : sans cela, une vidéo mal
  // étiquetée TEXT était rejetée ici en silence, sans le moindre message
  // d'erreur au client.
  const allMediaIds = [];
  if (mediaId) allMediaIds.push(mediaId);
  if (Array.isArray(mediaIds)) allMediaIds.push(...mediaIds);
  const uniqueMediaIds = [...new Set(allMediaIds)];

  if (type !== "TEXT" && uniqueMediaIds.length === 0) return;
  if (type === "TEXT" && uniqueMediaIds.length === 0 && (!content || !content.trim())) return;

  if (!(await isParticipant(convId, ws.userId))) {
    ws.send(JSON.stringify({ type: "error", message: "Conversation interdite", tempId }));
    return;
  }

  // MODIFICATION : vérifie tous les médias
  let premierMime = null;
  for (const mid of uniqueMediaIds) {
    const m = await prisma.mediaFile.findUnique({ where: { id: mid }, select: { ownerId: true, mimeType: true } });
    if (!m || m.ownerId !== ws.userId) {
      ws.send(JSON.stringify({ type: "error", message: "Media invalide", tempId }));
      return;
    }
    if (premierMime === null) premierMime = m.mimeType;
  }

  // Filet de sécurité : un message porteur de médias ne peut pas être un TEXT.
  // On corrige au lieu de faire confiance au client, sinon la donnée est
  // enregistrée fausse et le reste de la chaîne n'y peut plus rien.
  if (uniqueMediaIds.length > 0 && type === "TEXT") {
    type = typeDepuisMime(premierMime);
  }

  // Messages éphémères : si la conversation a un minuteur, calcule l'expiration.
  const convCfg = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { disappearingSeconds: true },
  });
  const ttl = convCfg?.disappearingSeconds ?? 0;
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

  const created = await prisma.message.create({
    data: {
      convId,
      senderId: ws.userId,
      content: content ?? null,
      type,
      status: "SENT",
      replyToId: msg.replyToId ?? null,
      expiresAt,
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

  // Blocage (conversation directe) : si l'un a bloqué l'autre, on ne délivre pas
  // le message au correspondant (ni WS, ni push, ni statut DELIVERED). Le message
  // reste chez l'émetteur ; il est aussi filtré à la lecture côté bloqueur.
  let blockedDirect = false;
  if (recipients.length === 2) {
    const other = recipients.find((uid) => uid !== ws.userId);
    if (other) blockedDirect = await areBlocked(ws.userId, other);
  }

  const otherOnline =
    !blockedDirect &&
    recipients.some((uid) => uid !== ws.userId && isUserOnline(uid));
  let finalStatus = created.status;
  if (otherOnline) {
    await prisma.message.update({ where: { id: created.id }, data: { status: "DELIVERED" } });
    finalStatus = "DELIVERED";
  }

  const messageWithStatus = { ...serialized, status: finalStatus };
  for (const uid of recipients) {
    if (uid !== ws.userId && blockedDirect) continue; // pas de livraison au bloqué
    sendTo(uid, {
      type: "message",
      message: messageWithStatus,
      tempId: uid === ws.userId ? tempId : undefined,
    });
  }

  if (isPushEnabled() && !blockedDirect) {
    const sender = await prisma.user.findUnique({
      where: { id: ws.userId },
    });
    // `nomAffichage` et non `pseudo` : c'est le NOM qui s'affiche partout
    // ailleurs, et la notification était le dernier endroit à montrer le
    // pseudo — un libellé d'inscription que 39 comptes sur 49 laissent vide.
    const senderName =
      (sender ? nomAffichage(sender) : null) ?? "Quelqu'un";
    const conv = await prisma.conversation.findUnique({
      where: { id: convId },
      include: { participants: { include: { user: true } } },
    });
    let convTitle = conv?.name ?? null;
    if (conv && !conv.isGroup) {
      const other = conv.participants.find((p) => p.userId !== ws.userId);
      convTitle =
        (other ? nomAffichage(other.user) : null) ?? convTitle;
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
  // Toujours mettre à jour le pointeur de lecture local (non-lus), même si les
  // confirmations de lecture sont désactivées.
  await prisma.participant.update({
    where: { convId_userId: { convId, userId: ws.userId } },
    data: { lastReadAt: now, unreadCount: 0 },
  });

  // Confidentialité : si l'utilisateur a désactivé les confirmations de lecture,
  // on NE marque PAS les messages comme "READ" et on ne prévient personne
  // (l'expéditeur ne verra donc jamais la double coche bleue).
  const me = await prisma.user.findUnique({
    where: { id: ws.userId },
    select: { readReceipts: true },
  });
  if (me && me.readReceipts === 0) return;

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

// Un appareil vient d'être déconnecté à distance : on prévient les autres
// sessions du MÊME compte pour qu'elles réagissent sans attendre.
//
// Pourquoi le client déclenche l'annonce plutôt que l'API : l'API Next.js et ce
// serveur sont deux process distincts, sans canal entre eux. Le client, lui,
// tient déjà une connexion authentifiée — il suffit de la relayer.
//
// Aucun risque d'abus : la diffusion est limitée à `ws.userId`, donc au compte
// de l'émetteur. On ne peut déconnecter que ses propres appareils, ce qui est
// exactement le pouvoir recherché.
//
// La révocation en base (DELETE /api/appareils/:id) reste indispensable : elle
// couvre l'appareil hors ligne au moment du clic, qui sera éjecté à son retour.
// Cet événement ne fait qu'accélérer le cas courant.
async function handleSessionRevoked(ws, msg) {
  const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
  if (!deviceId) return;
  sendTo(ws.userId, { type: "session_revoked", deviceId });
}

// Indicateur "en train d'enregistrer un vocal…" — miroir de handleTyping.
// Événement éphémère (aucune persistance), relayé aux autres participants.
async function handleRecording(ws, msg) {
  const { convId, isRecording } = msg;
  if (!convId || !(await isParticipant(convId, ws.userId))) return;
  const recipients = await participantsOf(convId);
  for (const uid of recipients) {
    if (uid === ws.userId) continue;
    sendTo(uid, { type: "recording", convId, userId: ws.userId, isRecording: Boolean(isRecording) });
  }
}

// Réaction emoji à un message (style WhatsApp : une réaction par user/message).
// - emoji fourni & différent de l'actuel → pose/remplace
// - emoji identique à l'actuel, ou emoji vide/null → retire
// Diffuse { type:"reaction", convId, messageId, userId, emoji|null } à tous.
// Édition d'un message : seul l'expéditeur, uniquement du TEXTE non supprimé.
// Diffuse { type:"message_edited", convId, messageId, content, editedAt } à tous.
async function handleEditMessage(ws, msg) {
  const { messageId } = msg;
  const content = typeof msg.content === "string" ? msg.content.trim() : "";
  if (!messageId || !content) return;

  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) {
    ws.send(JSON.stringify({ type: "error", message: "Message introuvable" }));
    return;
  }
  if (message.senderId !== ws.userId) {
    ws.send(JSON.stringify({ type: "error", message: "Seul l'expéditeur peut modifier ce message" }));
    return;
  }
  if (message.deletedAt || message.type !== "TEXT") return;

  const editedAt = new Date();
  await prisma.message.update({
    where: { id: messageId },
    data: { content, editedAt },
  });

  const recipients = await participantsOf(message.convId);
  for (const uid of recipients) {
    sendTo(uid, {
      type: "message_edited",
      convId: message.convId,
      messageId,
      content,
      editedAt,
    });
  }
}

// Épingler / détacher un message (partagé à toute la conversation).
// messageId = id à épingler, ou null/absent pour détacher.
// Diffuse { type:"message_pinned", convId, messageId|null } aux participants.
async function handlePinMessage(ws, msg) {
  const { convId } = msg;
  const messageId = typeof msg.messageId === "string" ? msg.messageId : null;
  if (!convId) return;
  if (!(await isParticipant(convId, ws.userId))) return;
  if (messageId) {
    const m = await prisma.message.findFirst({
      where: { id: messageId, convId },
      select: { id: true },
    });
    if (!m) return;
  }
  await prisma.conversation.update({
    where: { id: convId },
    data: { pinnedMessageId: messageId },
  });
  const recipients = await participantsOf(convId);
  for (const uid of recipients) {
    sendTo(uid, { type: "message_pinned", convId, messageId });
  }
}

// Messages éphémères : règle le minuteur de la conversation (0 = désactivé).
// Diffuse { type:"disappearing_updated", convId, seconds } aux participants.
async function handleSetDisappearing(ws, msg) {
  const { convId } = msg;
  const seconds = Number.isFinite(msg.seconds) ? Math.max(0, Math.floor(msg.seconds)) : 0;
  if (!convId) return;
  if (!(await isParticipant(convId, ws.userId))) return;
  await prisma.conversation.update({
    where: { id: convId },
    data: { disappearingSeconds: seconds },
  });

  // Message système persistant dans le fil (façon WhatsApp). Non éphémère.
  const label =
    seconds <= 0 ? "Messages éphémères désactivés"
    : seconds >= 7776000 ? "Messages éphémères activés · 90 jours"
    : seconds >= 604800 ? "Messages éphémères activés · 7 jours"
    : "Messages éphémères activés · 24 heures";
  const sys = await prisma.message.create({
    data: { convId, senderId: ws.userId, content: label, type: "SYSTEM", status: "SENT" },
    include: { media: true },
  });
  await prisma.conversation.update({
    where: { id: convId },
    data: {
      lastMessage: label,
      lastMessageAt: new Date(),
      lastMessageSenderID: ws.userId,
      lastMessageType: 2,
      lastMessageStatus: 0,
    },
  });
  const serialized = await serializeMessage(sys, sys.media);

  const recipients = await participantsOf(convId);
  for (const uid of recipients) {
    sendTo(uid, { type: "disappearing_updated", convId, seconds });
    sendTo(uid, { type: "message", message: serialized });
  }
}

async function handleReaction(ws, msg) {
  const { convId, messageId } = msg;
  const emoji = typeof msg.emoji === "string" ? msg.emoji.trim().slice(0, 16) : "";
  if (!convId || !messageId) return;
  if (!(await isParticipant(convId, ws.userId))) return;

  // Le message doit appartenir à cette conversation.
  const target = await prisma.message.findFirst({
    where: { id: messageId, convId },
    select: { id: true },
  });
  if (!target) return;

  const existing = await prisma.messageReaction.findUnique({
    where: { messageId_userId: { messageId, userId: ws.userId } },
    select: { emoji: true },
  });

  let finalEmoji = null;
  if (!emoji || (existing && existing.emoji === emoji)) {
    // Retrait (emoji vide, ou re-clic sur le même emoji = bascule).
    if (existing) {
      await prisma.messageReaction.delete({
        where: { messageId_userId: { messageId, userId: ws.userId } },
      });
    }
  } else {
    // Pose ou remplacement.
    await prisma.messageReaction.upsert({
      where: { messageId_userId: { messageId, userId: ws.userId } },
      create: { messageId, userId: ws.userId, emoji },
      update: { emoji },
    });
    finalEmoji = emoji;
  }

  const recipients = await participantsOf(convId);
  for (const uid of recipients) {
    sendTo(uid, {
      type: "reaction",
      convId,
      messageId,
      userId: ws.userId,
      emoji: finalEmoji,
    });
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

  const callerName = nomAffichage(call.initiator);
  const callerAvatarUrl = call.initiator.avatarUrl ?? null;
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
    // Blocage : ne fait pas sonner une personne bloquée (ou qui a bloqué l'appelant).
    if (await areBlocked(ws.userId, uid)) continue;
    const payload = {
      type: "incoming_call",
      callId,
      convId: call.convId,
      callType: call.type,
      callerId: ws.userId,
      callerName,
      callerAvatarUrl,
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

/**
 * Envoie une trame aux sockets d'un utilisateur qui participent À CET APPEL.
 *
 * ⚠️ `sendTo` écrit sur TOUTES les sockets du compte. Pour la signalisation
 * WebRTC c'est un défaut : quelqu'un connecté sur son téléphone et sur le web
 * voyait les offres SDP et les candidats ICE partir vers les deux, alors qu'un
 * seul appareil est dans l'appel. L'autre les empilait dans un tampon qu'il ne
 * vidait jamais, et pouvait répondre à une négociation qui ne le concernait pas.
 *
 * Une socket déclare l'appel qu'elle a rejoint dans `ws.callIdActif` (posé par
 * `handleCallState`). On ne retient donc que celles-là.
 *
 * Repli délibéré : si AUCUNE socket n'a encore déclaré cet appel — le cas
 * pendant la sonnerie, avant tout décrochage — on retombe sur `sendTo`. Sans ce
 * repli, la toute première offre n'atteindrait personne.
 */
function envoieAuxSocketsDeLAppel(userId, callId, payload) {
  const set = clients.get(userId);
  if (!set) return false;
  const data = JSON.stringify(payload);
  let cible = false;
  for (const s of set) {
    if (s.readyState === s.OPEN && s.callIdActif === callId) {
      s.send(data);
      cible = true;
    }
  }
  if (cible) return true;
  return sendTo(userId, payload);
}

async function handleCallSignal(ws, msg) {
  const { callId, toUserId, signal } = msg;
  if (!callId || !toUserId || !signal) return;
  const ids = await callParticipantIds(callId);
  if (!ids.includes(ws.userId) || !ids.includes(toUserId)) return;
  envoieAuxSocketsDeLAppel(toUserId, callId, {
    type: "call_signal",
    callId,
    from: ws.userId,
    signal,
  });
}

/**
 * Pousse l'enregistrement d'appel complet à chaque participant, une fois
 * l'appel clos.
 *
 * Remplace le schéma « le serveur signale, le client recharge tout
 * l'historique » : le client recevait `call_state`, attendait 800 ms, puis
 * refaisait un `GET /api/calls` de 50 appels pour n'en découvrir qu'un.
 *
 * ⚠️ LA CHARGE EST CALCULÉE PAR DESTINATAIRE, et c'est ce qui distingue un
 * appel d'un message. Un message est identique pour tout le monde et se diffuse
 * tel quel ; un appel est sortant pour l'un, entrant pour l'autre, avec un
 * libellé et un correspondant différents. Sérialiser une seule fois pour tous
 * afficherait « Appel sortant » chez celui qui l'a reçu.
 *
 * Le délai de 800 ms côté client n'avait pas lieu d'être : `hangUp` attend la
 * réponse de `POST /api/calls/:id/end` AVANT d'émettre `call_state`, donc la
 * base est déjà à jour quand cet événement nous parvient.
 */
async function diffuseAppelTermine(callId, ids) {
  try {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      include: { participants: { include: { user: true } } },
    });
    if (!call || !STATUTS_TERMINAUX.includes(call.status)) return;

    const conv = call.convId
      ? await prisma.conversation.findUnique({
          where: { id: call.convId },
          select: { isGroup: true, name: true },
        })
      : null;

    for (const uid of ids) {
      sendTo(uid, { type: "call_ended", call: serialiseAppelPour(call, conv, uid) });
    }
  } catch (e) {
    // Le relais de `call_state` a déjà eu lieu : en cas d'échec ici, le client
    // garde son ancien chemin de rattrapage (rechargement au retour au premier
    // plan ou à la reconnexion). On ne fait pas tomber la signalisation pour
    // autant.
    console.error("[ws] diffuseAppelTermine:", e?.message ?? e);
  }
}

async function handleCallState(ws, msg) {
  const { callId, state, userId: joinedUserId, displayName } = msg;
  if (!callId || !state) return;
  const ids = await callParticipantIds(callId);
  if (!ids.includes(ws.userId)) return;

  // La socket déclare l'appel qu'elle porte, ce qui permet d'adresser la
  // signalisation WebRTC à L'APPAREIL et non au compte — voir
  // `envoieAuxSocketsDeLAppel`. « joined » marque l'entrée ; toute fin la
  // libère, sans quoi une socket resterait éternellement rattachée à un appel
  // terminé et capterait la signalisation du suivant.
  if (state === "joined" || state === "ringing") {
    ws.callIdActif = callId;
  } else if (ws.callIdActif === callId) {
    ws.callIdActif = null;
  }
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

  // Si l'appel est clos, pousser l'enregistrement COMPLET dans la foulée.
  await diffuseAppelTermine(callId, ids);

  // Push data-only pour retirer la notification d'appel plein écran chez les
  // destinataires dont l'application est FERMÉE : le WebSocket ne les atteint
  // pas. Ciblé par le callId partagé.
  //
  // Deux situations distinctes, et c'est ce que l'ancienne version manquait :
  //
  //  - appel terminé/refusé/annulé : tout le monde doit retirer sa notification,
  //    y compris les AUTRES appareils de celui qui vient d'agir. L'ancien
  //    `if (uid === ws.userId) continue` les sautait, si bien que refuser un
  //    appel sur le web laissait sonner un téléphone dont l'app était fermée ;
  //
  //  - appel décroché : seuls les autres appareils de celui qui a décroché sont
  //    concernés. Envoyer une annulation aux autres participants serait un
  //    contresens — pour eux, l'appel commence.
  if (isPushEnabled()) {
    const termine = ["ended", "rejected", "declined", "cancelled"].includes(state);
    const decroche = ["joined", "accepted"].includes(state);
    if (termine || decroche) {
      for (const uid of ids) {
        if (decroche && uid !== ws.userId) continue;
        await pushCallCancelled(prisma, { recipientId: uid, callId });
      }
    }
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
  // Contrôle de blocage, absent ici alors que `handleCallRing` l'applique
  // (ligne ~876) : inviter dans un appel permettait donc de joindre quelqu'un
  // qui vous a bloqué — un contournement du blocage.
  if (await areBlocked(ws.userId, invitee.id)) {
    ws.send(JSON.stringify({ type: "call_invite_result", ok: false, reason: "BLOCKED", publicNumber }));
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
  const callerName = (inviter ? nomAffichage(inviter) : null) ?? "Quelqu'un";
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
  // ⚠️ MÊME TRAITEMENT QUE `handleCallRing`, qui manquait ici. `sendTo` seul ne
  // suffit pas : un invité dont l'application est fermée n'a aucune socket, la
  // trame était donc perdue, sans mise en tampon ni notification. L'inviteur
  // recevait pourtant `ok: true` et croyait l'invitation partie.
  const chargeInvite = {
    type: "incoming_call",
    callId,
    convId: call.convId,
    callType: call.type,
    callerId: ws.userId,
    callerName,
    // Absent ici alors que `handleCallRing` l'envoie : l'écran d'appel de
    // l'invité s'affichait donc sans photo.
    callerAvatarUrl: inviter?.avatarUrl ?? null,
    isGroup: true, // multi-partie tant que l'invité rejoint
    groupName,
    memberCount: memberCount + 1,
  };
  if (!sendTo(invitee.id, chargeInvite)) {
    bufferPendingCall(invitee.id, chargeInvite);
  }
  if (isPushEnabled()) {
    await pushIncomingCall(prisma, {
      recipientId: invitee.id,
      callId,
      convId: call.convId,
      callerName,
      callType: call.type,
      isGroup: true,
      groupName,
    });
  }

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

    // Fait remonter la conversation cible (dernier message dénormalisé) et
    // incrémente les non-lus — un message transféré est un vrai nouveau message.
    await prisma.conversation.update({
      where: { id: targetConvId },
      data: {
        updatedAt: new Date(),
        lastMessage: (original.content ?? "").slice(0, 500) || null,
        lastMessageAt: new Date(),
        lastMessageSenderID: ws.userId,
        lastMessageType:
          original.type === "TEXT" ? 0
          : original.type === "IMAGE" ? 1
          : original.type === "AUDIO" ? 3
          : original.type === "VIDEO" ? 4
          : 2,
        lastMessageStatus: 0,
      },
    });
    await prisma.participant.updateMany({
      where: { convId: targetConvId, userId: { not: ws.userId } },
      data: { unreadCount: { increment: 1 } },
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
  // Au démarrage, aucune socket n'est encore connectée : on remet tout le monde
  // hors-ligne pour éviter les « en ligne » fantômes survivant à un restart.
  // Les utilisateurs repasseront en ligne à leur reconnexion WS.
  prisma.user
    .updateMany({ where: { isOnline: 1 }, data: { isOnline: 0 } })
    .then((r) => {
      if (r.count > 0) console.log(`[ws] Présence réinitialisée (${r.count} users)`);
    })
    .catch((e) => console.error("[ws] reset présence au démarrage:", e));

  // Purge des statuts expirés : une fois au démarrage, puis toutes les heures.
  purgeExpiredStatuses();
  setInterval(purgeExpiredStatuses, 60 * 60 * 1000);
  // Toutes les 30 s : bien plus court que le délai de 90 s, pour qu'un appel
  // abandonné ne survive jamais longtemps à son échéance.
  fermeAppelsPerimes();
  setInterval(fermeAppelsPerimes, 30 * 1000);
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
  announcePresence(userId, true).catch(() => {}); // en ligne + diffusion
  sendPresenceSnapshot(userId, ws).catch(() => {}); // état des contacts en ligne
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
      else if (msg.type === "recording") await handleRecording(ws, msg);
      else if (msg.type === "session_revoked") await handleSessionRevoked(ws, msg);
      else if (msg.type === "reaction") await handleReaction(ws, msg);
      else if (msg.type === "call_ring") await handleCallRing(ws, msg);
      else if (msg.type === "call_signal") await handleCallSignal(ws, msg);
      else if (msg.type === "call_state") await handleCallState(ws, msg);
      else if (msg.type === "call_invite") await handleCallInvite(ws, msg);
      else if (msg.type === "delete_message") await handleDeleteMessage(ws, msg);
      else if (msg.type === "edit_message") await handleEditMessage(ws, msg);
      else if (msg.type === "pin_message") await handlePinMessage(ws, msg);
      else if (msg.type === "set_disappearing") await handleSetDisappearing(ws, msg);
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
    markOfflineIfGone(userId, ws); // hors-ligne + lastSeen si dernière socket
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
  ws.on("error", () => markOfflineIfGone(userId, ws));
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
