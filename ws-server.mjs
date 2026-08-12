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
import { isPushEnabled, pushIncomingCall, pushNewMessage, pushCallCancelled, pushMeetingReminder } from "./push.mjs";
// Mêmes règles de libellé que l'API HTTP — voir l'en-tête de ce fichier pour la
// raison du JavaScript plutôt que du TypeScript.
import {
  serialiseAppelPour,
  STATUTS_TERMINAUX,
  DELAI_SANS_REPONSE_MS,
} from "./src/lib/call-labels.mjs";
import { nomAffichage } from "./src/lib/display-name.mjs";
import {
  DELAI_MENU_MS,
  DELAI_SONNERIE_AGENT_MS,
  choisirAgentLibre,
  choisirMusiqueAttente,
  estCompteCentre,
  lireMenuCentre,
  optionsPubliques,
  urlInviteCentre,
} from "./src/lib/ivr.mjs";

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

/**
 * Envoie a un SEUL appareil du compte, celui qui detient le verrou.
 *
 * `sendTo` arrose tous les appareils : c'est ce qu'on veut pour un changement
 * d'etat, pas pour une sonnerie d'appel qu'un seul poste doit entendre.
 */
function sendToAppareil(userId, appareilId, payload) {
  const set = clients.get(userId);
  if (!set) return false;
  const data = JSON.stringify(payload);
  let delivered = false;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN && ws.appareilId === appareilId) {
      ws.send(data);
      delivered = true;
    }
  }
  return delivered;
}

/**
 * Appareil qui detient la conversation pour ce compte, ou null.
 *
 * Le verrou reserve la conversation a UN poste : les autres appareils du meme
 * compte ne peuvent ni ecrire, ni appeler ce correspondant, ni etre sonnes par
 * lui. Ils suivent le fil en lecture, et retrouvent tous leurs droits des que
 * le detenteur rend la main.
 */
/**
 * Ce compte a-t-il au moins une socket qui a annonce son appareil ?
 *
 * C'est la question qui decide si une reservation est APPLICABLE. Le ciblage
 * par appareil repose sur `{type:"device"}` ; un client qui ne l'envoie pas est
 * invisible au ciblage, et vouloir lui reserver un appel revient a le faire
 * disparaitre. Tant qu'aucune socket du compte ne s'identifie, on ne peut pas
 * honorer le verrou — on prefere sonner partout plutot que nulle part.
 *
 * Des que le client s'annoncera, ce repli s'effacera de lui-meme.
 */
function compteIdentifie(userId) {
  const set = clients.get(userId);
  if (!set) return false;
  for (const ws of set) {
    if (ws.readyState === ws.OPEN && ws.appareilId != null) return true;
  }
  return false;
}

async function detenteurDuVerrou(convId, userId) {
  if (!convId) return null;
  const verrou = await prisma.conversationLock.findUnique({
    where: { convId_userId: { convId, userId } },
    select: { appareilId: true },
  });
  return verrou?.appareilId ?? null;
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

/**
 * Blocage entre deux personnes d'une conversation directe, avec le sens.
 * Renvoie null si personne n'a bloque personne.
 */
async function detailBlocage(userA, userB) {
  const row = await prisma.blocked.findFirst({
    where: {
      OR: [
        { alanyaID: userA, idCallerBlock: userB },
        { alanyaID: userB, idCallerBlock: userA },
      ],
    },
    select: { alanyaID: true, idCallerBlock: true },
  });
  if (!row) return null;
  return { bloqueurId: row.alanyaID, bloqueId: row.idCallerBlock };
}

/**
 * Avis systeme de blocage, depose dans la conversation et diffuse aux deux.
 *
 * Le texte n'est PAS fige ici : chacun lit l'application dans sa langue, et le
 * bloqueur et le bloque ne lisent pas la meme phrase. On enregistre donc un
 * code et ses parametres ; chaque client compose « Vous avez bloque X » ou
 * « Vous avez ete bloque par Y » selon qu'il est l'un ou l'autre.
 *
 * Un seul avis par blocage : sans ce garde-fou, chaque tentative d'envoi en
 * ajouterait un et la conversation se remplirait d'avis identiques.
 */
async function deposerAvisDeBlocage(convId, bloqueurId, bloqueId) {
  const dernier = await prisma.message.findFirst({
    where: { convId, type: "SYSTEM" },
    orderBy: { createdAt: "desc" },
    select: { content: true },
  });
  if (dernier?.content?.includes('"blocked_notice"')) return null;

  const [bloqueur, bloque] = await Promise.all([
    prisma.user.findUnique({ where: { id: bloqueurId }, select: { pseudo: true, publicNumber: true } }),
    prisma.user.findUnique({ where: { id: bloqueId }, select: { pseudo: true, publicNumber: true } }),
  ]);

  const charge = JSON.stringify({
    code: "blocked_notice",
    blockerId: bloqueurId,
    blockerName: bloqueur?.pseudo ?? bloqueur?.publicNumber ?? "",
    blockedName: bloque?.pseudo ?? bloque?.publicNumber ?? "",
  });

  const avis = await prisma.message.create({
    data: { convId, senderId: bloqueurId, content: charge, type: "SYSTEM", status: "SENT" },
    include: { media: true },
  });
  const serialise = await serializeMessage(avis, avis.media);
  for (const uid of [bloqueurId, bloqueId]) sendTo(uid, { type: "message", message: serialise });
  return avis;
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
        clos = restants < 2;
      }
      if (!clos) {
        // Les autres participants restent en appel mais sont prévenus du départ.
        for (const uid of participants) {
          if (uid !== userId) sendTo(uid, { type: "call_state", callId: appel.id, state: "left", from: userId, userId });
        }
        continue;
      }

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

/* ----------------- Verrou de conversation ----------------- */

/**
 * Un verrou ne se perime plus.
 *
 * Il a d'abord expire au bout de deux minutes sans signe de vie, pour qu'une
 * fermeture brutale ne reserve pas une conversation a jamais. C'etait une
 * mauvaise lecture du besoin : un agent qui prend une conversation en charge la
 * garde jusqu'a ce qu'il ait FINI, pas jusqu'a ce qu'il ferme son navigateur.
 * Rendre la main a sa place le mettait en concurrence avec ses collegues des
 * qu'il changeait de piece.
 *
 * La reservation survit donc a la deconnexion, a la fermeture de session, au
 * redemarrage. Seul son detenteur la retire, en revenant.
 *
 * `expires_at` est NOT NULL en base : on y ecrit une date lointaine, et plus
 * personne ne la relit. La colonne reste pour ne pas imposer de migration.
 */
function peremptionVerrou() {
  return new Date("2999-12-31T00:00:00.000Z");
}

/** Etat diffuse aux appareils du compte. */
function serialiseVerrou(convId, verrou) {
  return {
    type: "conversation_lock",
    convId,
    locked: verrou !== null,
    appareilId: verrou?.appareilId ?? null,
    detenteur: verrou?.detenteur ?? null,
    expiresAt: verrou?.expiresAt ?? null,
  };
}

/**
 * Pose ou retire le verrou d'une conversation.
 *
 * Le verrou appartient au COMPTE et designe l'appareil qui a la main : c'est
 * entre appareils d'un meme compte que la reservation se joue, jamais entre
 * comptes. L'etat est diffuse a toutes les sockets du compte — le registre est
 * `userId -> Set<ws>`, cibler « mes autres appareils » est donc immediat.
 *
 * Le verrou ne gouverne QUE l'ecriture : aucune diffusion de message ne le
 * consulte, et les appareils qui le subissent continuent de tout recevoir.
 */
async function handleConversationLock(ws, msg) {
  const { convId, lock, appareilId, detenteur } = msg;
  if (!convId || !(await isParticipant(convId, ws.userId))) return;

  const cle = { convId_userId: { convId, userId: ws.userId } };

  if (lock === false) {
    const existant = await prisma.conversationLock.findUnique({ where: cle });
    // Seul le detenteur rend la main : un autre appareil ne peut pas se
    // l'arracher, sinon la reservation ne protegerait rien.
    if (!existant) return;
    if (ws.appareilId != null && existant.appareilId !== ws.appareilId) return;
    await prisma.conversationLock.delete({ where: cle });
    sendTo(ws.userId, serialiseVerrou(convId, null));
    return;
  }

  const idAppareil = Number(appareilId ?? ws.appareilId ?? 0);
  if (!Number.isFinite(idAppareil) || idAppareil <= 0) return;
  // On retient l'appareil sur la socket : c'est ce qui permet de rendre la main
  // toute seule a la deconnexion.
  ws.appareilId = idAppareil;

  const nom = typeof detenteur === "string" ? detenteur.slice(0, 80) : null;
  const existant = await prisma.conversationLock.findUnique({ where: cle });
  if (existant && existant.appareilId !== idAppareil) {
    // Premier arrive, premier servi : on renvoie l'etat reel au demandeur
    // plutot que de le laisser croire qu'il a la main.
    ws.send(JSON.stringify(serialiseVerrou(convId, existant)));
    return;
  }

  const verrou = await prisma.conversationLock.upsert({
    where: cle,
    create: {
      convId,
      userId: ws.userId,
      appareilId: idAppareil,
      detenteur: nom,
      expiresAt: peremptionVerrou(),
    },
    update: { appareilId: idAppareil, detenteur: nom, expiresAt: peremptionVerrou() },
  });
  sendTo(ws.userId, serialiseVerrou(convId, verrou));
}

async function handleSend(ws, msg) {
  // MODIFICATION : ajoute mediaIds pour multi-médias
  const { convId, content, tempId, mediaId, mediaIds } = msg;
  /**
   * Appareil emetteur, quand le client l'indique.
   *
   * Il sert a etiqueter le message du pseudo de l'appareil, visible seulement
   * par les autres appareils du meme compte. On ne fait PAS confiance a ce que
   * le client affirme : l'appartenance est verifiee plus bas contre le registre.
   */
  const appareilAnnonce = Number(msg.appareilId ?? 0);
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

  /**
   * Blocage : le message n'est ni enregistre, ni acquitte, ni livre.
   *
   * Le controle etait fait APRES l'enregistrement, et l'expediteur recevait
   * quand meme son echo : son indicateur passait a « envoye » alors que rien
   * n'etait parti. Sans ack, il ne se resout jamais — c'est le comportement
   * attendu. Le client court-circuite aussi de son cote ; ce refus-ci est la
   * defense, pour qu'un client modifie ne puisse pas passer outre.
   *
   * Deux cas, selon les accuses de lecture de la personne BLOQUEE :
   * - desactives : rien du tout, elle n'apprend pas qu'elle est bloquee ;
   * - actives : un avis systeme parait des deux cotes.
   */
  const participants = await participantsOf(convId);
  if (participants.length === 2) {
    const autre = participants.find((uid) => uid !== ws.userId);
    const blocage = autre ? await detailBlocage(ws.userId, autre) : null;
    if (blocage) {
      const bloque = await prisma.user.findUnique({
        where: { id: blocage.bloqueId },
        select: { readReceipts: true },
      });
      if ((bloque?.readReceipts ?? 1) !== 0) {
        await deposerAvisDeBlocage(convId, blocage.bloqueurId, blocage.bloqueId);
      }
      return;
    }
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

  /**
   * Verrou de conversation : un poste qui n'a pas la main n'ecrit pas.
   *
   * Le controle vivait uniquement dans l'interface web — la barre de saisie y
   * disparait. Un client qui ne l'implemente pas (le mobile) ou un client
   * modifie pouvait donc ecrire dans une conversation reservee. La regle
   * s'applique desormais ici, ou personne ne peut la contourner.
   *
   * Comme pour les appels, on ne refuse que si la socket s'est annoncee : sans
   * identite, on ne peut pas distinguer le detenteur d'un autre poste, et
   * refuser reviendrait a l'empecher d'ecrire dans SA propre reservation. Cette
   * tolerance disparait des que le client envoie `device`.
   */
  if (ws.appareilId != null) {
    const detenteur = await detenteurDuVerrou(convId, ws.userId);
    if (detenteur !== null && detenteur !== ws.appareilId) {
      ws.send(
        JSON.stringify({
          type: "conversation_lock",
          convId,
          locked: true,
          appareilId: detenteur,
          detenteur: null,
          expiresAt: null,
        }),
      );
      return;
    }
  }

  // L'appareil doit appartenir au compte qui envoie. Sans ce controle, n'importe
  // qui pourrait attribuer son message a l'appareil d'un collegue.
  let appareilEmetteur = null;
  if (Number.isFinite(appareilAnnonce) && appareilAnnonce > 0) {
    const ligne = await prisma.appareil.findFirst({
      where: { appareilId: appareilAnnonce, alanyaId: ws.userId },
      select: { appareilId: true, agent: true },
    });
    if (ligne) {
      appareilEmetteur = ligne;
      // On retient l'appareil sur la socket : le verrou s'en sert aussi pour
      // rendre la main tout seul a la deconnexion.
      ws.appareilId = ligne.appareilId;
    }
  }

  const created = await prisma.message.create({
    data: {
      convId,
      senderId: ws.userId,
      appareilId: appareilEmetteur?.appareilId ?? null,
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
  // Le blocage a deja renvoye plus haut : tout message qui arrive ici est
  // legitime, il n'y a plus de cas a ecarter au moment de la livraison.
  const recipients = participants;

  const otherOnline = recipients.some((uid) => uid !== ws.userId && isUserOnline(uid));
  let finalStatus = created.status;
  if (otherOnline) {
    await prisma.message.update({ where: { id: created.id }, data: { status: "DELIVERED" } });
    finalStatus = "DELIVERED";
  }

  const messageWithStatus = { ...serialized, status: finalStatus };
  /**
   * Le pseudo d'appareil n'est ajoute QUE dans la charge destinee au compte
   * emetteur — c'est-a-dire a ses propres appareils. Les autres comptes ne le
   * recoivent pas du tout : on ne compte pas sur le client pour le cacher.
   */
  const pourMoi =
    appareilEmetteur?.agent
      ? {
          ...messageWithStatus,
          nomAgent: appareilEmetteur.agent,
          // L'appareil emetteur voyage avec le pseudo, dans la MEME charge
          // restreinte au compte. Il sert au client a se reconnaitre : un poste
          // n'affiche pas son propre nom au-dessus de ses propres messages —
          // il sait deja qui il est. Seuls les AUTRES appareils du compte le
          // voient, et c'est tout l'interet.
          appareilId: appareilEmetteur.appareilId,
        }
      : messageWithStatus;
  for (const uid of recipients) {
    sendTo(uid, {
      type: "message",
      message: uid === ws.userId ? pourMoi : messageWithStatus,
      tempId: uid === ws.userId ? tempId : undefined,
    });
  }

  if (isPushEnabled()) {
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
/**
 * Éjecte les sockets dont l'appareil a été fermé, sans attendre que le client
 * s'en aperçoive.
 *
 * ⚠️ POURQUOI CE BALAYAGE EXISTE. Une socket ne s'authentifie QU'À SON
 * OUVERTURE : passé ce moment, plus rien ne la revérifie. Un appareil évincé
 * garde donc son temps réel — messages, appels, présence — aussi longtemps qu'il
 * ne se déconnecte pas, c'est-à-dire potentiellement des heures. La révocation
 * des jetons ne l'atteint pas : elle ne joue que sur l'API HTTP.
 *
 * Les deux autres chemins couvrent déjà le cas courant — le nouvel arrivant
 * annonce l'éviction, et l'appareil éteint l'apprend à son rafraîchissement.
 * Celui-ci ferme le trou qui reste : un appareil ALLUMÉ dont personne n'a pu
 * prévenir, parce que le réseau de l'arrivant a lâché au mauvais moment.
 *
 * Il ne coûte rien : la requête ne porte que sur les appareils réellement
 * connectés, et chaque socket n'est traitée qu'une fois.
 */
async function ejecteLesAppareilsFermes() {
  // On ne peut viser que les sockets qui se sont annoncées. Une socket muette
  // reste hors de portée — c'est la même limite que le verrou de conversation.
  const parAppareil = new Map();
  for (const set of clients.values()) {
    for (const ws of set) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.appareilId == null || ws.evictionNotifiee) continue;
      if (!parAppareil.has(ws.appareilId)) parAppareil.set(ws.appareilId, []);
      parAppareil.get(ws.appareilId).push(ws);
    }
  }
  if (parAppareil.size === 0) return;

  try {
    const fermes = await prisma.appareil.findMany({
      where: { appareilId: { in: [...parAppareil.keys()] }, destroy: 1 },
      select: { appareilId: true, cookiesWebId: true },
    });

    for (const appareil of fermes) {
      for (const ws of parAppareil.get(appareil.appareilId) ?? []) {
        // Une seule fois par socket : sans ce drapeau, le balayage suivant
        // renverrait l'ordre toutes les 30 s à un client qui n'a peut-être pas
        // encore fini de se déconnecter.
        ws.evictionNotifiee = true;
        try {
          ws.send(
            JSON.stringify({
              type: "session_revoked",
              deviceId: appareil.cookiesWebId,
              raison: "eviction",
            }),
          );
        } catch {}
        /*
         * On laisse au client le temps de traiter l'annonce avant de couper :
         * fermer dans la foulée lui retirerait le message qu'il doit afficher.
         * Passé ce délai, la socket tombe quoi qu'il arrive — c'est ce qui rend
         * l'éviction réelle, et non une demande polie.
         */
        setTimeout(() => {
          try {
            ws.close(4003, "Session fermée depuis un autre appareil");
          } catch {}
        }, 2000);
      }
      console.log(`[ws] appareil ${appareil.appareilId} éjecté (session fermée ailleurs)`);
    }
  } catch (e) {
    console.error("[ws] ejecteLesAppareilsFermes:", e?.message ?? e);
  }
}

async function handleSessionRevoked(ws, msg) {
  const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
  if (!deviceId) return;
  /**
   * `raison` est relayée telle quelle, et c'est ce qui permet à l'appareil visé
   * de dire la VÉRITÉ à son utilisateur. Deux causes très différentes passent
   * par le même événement :
   *
   *  - `"eviction"` — quelqu'un vient d'ouvrir une session sur un autre
   *    appareil de la même famille ;
   *  - absente — l'utilisateur a lui-même déconnecté ce poste depuis l'écran
   *    « Appareils connectés ».
   *
   * Sans elle, le second cas afficherait « votre compte a été ouvert sur un
   * autre appareil » à quelqu'un qui vient simplement de faire le ménage.
   *
   * La diffusion reste bornée à `ws.userId` : on ne peut couper que ses propres
   * appareils, quelle que soit la raison annoncée.
   */
  const raison = typeof msg.raison === "string" ? msg.raison.trim().slice(0, 20) : null;
  sendTo(ws.userId, { type: "session_revoked", deviceId, raison });
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

// ===============================================================
// Centre d'appels (IVR)
// ===============================================================
//
// Le numéro d'un centre n'est le téléphone de PERSONNE : c'est le serveur qui
// répond à sa place. Quand l'appelé porte `type_compte = 3`, on ne fait sonner
// personne — on ouvre une session, on envoie le menu, et c'est la touche tapée
// qui déclenchera la vraie sonnerie chez un agent, DANS LE MÊME APPEL.
//
// « Dans le même appel » est ce qui fait tout tenir : la salle WebRTC d'Alanya
// est le `callId`. L'agent n'est donc pas mis en relation avec l'appelant — il
// REJOINT l'appel que l'appelant a déjà ouvert, exactement comme un invité de
// transfert. Rien à ponter, rien à réimplémenter : le push, la sonnerie native,
// l'historique et la détection « déjà en ligne » suivent d'eux-mêmes.
//
// ⚠️ Registre SÉPARÉ de tout le reste. Tant que l'appelant est dans le menu, il
// n'y a pas de conversation : polluer les registres d'appel ferait apparaître un
// interlocuteur qui n'existe pas encore.
//
// callId -> {
//   callId, convId, appelantId,
//   centreId, nomCentre, centrePublicNumber,
//   options,       // [{ digit, label, agentIds }] — agentIds NE SORT JAMAIS
//   urlAttente,
//   agentId, agentLabel,
//   etape,         // 'menu' (attend une touche) | 'sonnerie' | 'ponte'
//   minuteur,
// }
const sessionsIvr = new Map();

function sessionIvr(callId) {
  return callId ? sessionsIvr.get(callId) ?? null : null;
}

/**
 * Ferme une session — LE SEUL endroit qui la retire du registre.
 *
 * Appelée depuis tous les chemins de sortie : fin d'appel, départ, déconnexion
 * de l'appelant, expiration du menu. Une session oubliée continuerait de router
 * la signalisation d'un appel terminé, et son minuteur tuerait l'appel SUIVANT.
 */
function fermerSessionIvr(callId) {
  const session = sessionsIvr.get(callId);
  if (!session) return;
  if (session.minuteur) clearTimeout(session.minuteur);
  session.minuteur = null;
  sessionsIvr.delete(callId);
}

/**
 * Clôt en base un appel qui n'a jamais atteint d'agent.
 *
 * `updateMany` avec `status: "RINGING"` dans le filtre, et non un `update` :
 * c'est ce qui rend l'opération sans effet si l'appel a bougé entre-temps —
 * décroché par un agent, raccroché par l'appelant. Le minuteur du menu peut
 * ainsi se déclencher en retard sans rien casser.
 */
async function cloreAppelIvr(callId) {
  try {
    const maj = await prisma.call.updateMany({
      where: { id: callId, status: "RINGING" },
      data: { status: "NO_ANSWER", endedAt: new Date() },
    });
    if (maj.count === 0) return;
    await prisma.callParticipant.updateMany({
      where: { callId, leftAt: null },
      data: { leftAt: new Date() },
    });
  } catch (e) {
    console.error("[ivr] cloreAppelIvr:", e?.message ?? e);
  }
}

function envoieAAppelant(session, payload) {
  sendTo(session.appelantId, payload);
}

/**
 * 60 s sans toucher une touche → on referme.
 *
 * ⚠️ On envoie `ivr_error` et RIEN D'AUTRE. Y ajouter un `call_ended` fermerait
 * l'écran dans la même milliseconde et le message n'aurait pas le temps d'être
 * lu. L'appel est clos en base ; c'est le client qui décide quand refermer.
 */
function armerMinuteurMenu(session) {
  if (session.minuteur) clearTimeout(session.minuteur);
  session.etape = "menu";
  session.minuteur = setTimeout(async () => {
    const vivante = sessionsIvr.get(session.callId);
    if (!vivante || vivante.etape !== "menu") return;
    envoieAAppelant(vivante, {
      type: "ivr_error",
      callId: vivante.callId,
      code: "timeout",
      retry: false,
      message: "Aucun choix effectué. Rappelez quand vous voudrez.",
    });
    fermerSessionIvr(vivante.callId);
    await cloreAppelIvr(vivante.callId);
  }, DELAI_MENU_MS);
}

/**
 * Ouvre le standard : personne ne sonne, l'appelant reçoit le menu.
 *
 * L'appelant est déjà « occupé » sans qu'on ait rien à écrire : `estOccupe` se
 * calcule sur les lignes `callParticipant` d'un appel en sonnerie, et l'appel
 * existe depuis `POST /api/calls`. Un appel entrant ne viendra donc pas sonner
 * en pleine sélection de service.
 */
async function ouvrirSessionIvr(ws, call, centre) {
  const nomCentre = nomAffichage(centre) ?? centre.publicNumber;
  const options = await lireMenuCentre(prisma, centre.id);

  if (options.length === 0) {
    sendTo(ws.userId, {
      type: "ivr_error",
      callId: call.id,
      code: "no_service",
      retry: false,
      message: `${nomCentre} n'a aucun service joignable pour le moment.`,
    });
    await cloreAppelIvr(call.id);
    return;
  }

  // Une session résiduelle sur le même identifiant ne doit pas emporter le
  // nouvel appel avec elle : on la jette SANS ses effets de bord (ni clôture en
  // base, ni message à l'appelant — il est en train de rappeler).
  fermerSessionIvr(call.id);

  const session = {
    callId: call.id,
    convId: call.convId,
    appelantId: ws.userId,
    centreId: centre.id,
    nomCentre,
    centrePublicNumber: centre.publicNumber,
    options,
    // Tirée MAINTENANT, pas au moment de la touche : le client la met en cache
    // pendant que l'invite se joue.
    urlAttente: choisirMusiqueAttente(),
    agentId: null,
    agentLabel: null,
    etape: "menu",
    minuteur: null,
  };
  sessionsIvr.set(call.id, session);
  armerMinuteurMenu(session);

  // La socket déclare l'appel qu'elle porte dès maintenant — même rôle que le
  // `socket.join(roomId)` d'une pile Socket.IO : quand l'agent décrochera, il
  // n'y aura plus rien à préparer pour que la signalisation trouve sa cible.
  ws.callIdActif = call.id;

  sendTo(ws.userId, {
    type: "ivr_menu",
    callId: call.id,
    convId: call.convId,
    centerId: centre.id,
    centerName: nomCentre,
    centerNumber: centre.publicNumber,
    centerAvatarUrl: centre.avatarUrl ?? null,
    promptUrl: await urlInviteCentre(prisma, centre),
    holdUrl: session.urlAttente,
    options: optionsPubliques(options),
  });
  console.log(`[ivr] menu ouvert — appel ${call.id}, centre ${nomCentre}, ${options.length} service(s)`);
}

/**
 * Réécrit un `call_state` POUR L'APPELANT, et pour lui seul.
 *
 * L'appelant n'a jamais eu affaire qu'au centre : c'est le centre qui décroche,
 * c'est le centre qui raccroche. Tout ce qui désigne l'agent est renommé.
 *
 * ⚠️ Ce n'est pas cosmétique. Le client range ses pairs WebRTC par identifiant :
 * l'identifiant annoncé ici DEVIENT la clé de la connexion chez l'appelant, et
 * c'est celle que `relaisIvr` s'attend à voir revenir dans ses signaux. Les deux
 * réécritures forment une paire — changer l'une sans l'autre casse l'appel.
 *
 * Les autres destinataires — l'agent, ses propres appareils — reçoivent la
 * charge telle quelle : eux savent parfaitement qui ils sont.
 */
function chargeCallStatePour(session, destinataireId, payload) {
  if (!session || !session.agentId) return payload;
  if (destinataireId !== session.appelantId) return payload;
  const parleDeLAgent =
    payload.from === session.agentId || payload.userId === session.agentId;
  if (!parleDeLAgent) return payload;
  return {
    ...payload,
    from: payload.from === session.agentId ? session.centreId : payload.from,
    userId: payload.userId === session.agentId ? session.centreId : payload.userId,
    displayName:
      payload.userId === session.agentId ? session.nomCentre : payload.displayName,
  };
}

/**
 * Fait sonner un agent DANS L'APPEL QUE L'APPELANT A DÉJÀ OUVERT.
 *
 * C'est tout le principe : l'agent n'est pas mis en relation avec l'appelant, il
 * REJOINT le `callId` existant — exactement comme l'invité d'un transfert. La
 * salle WebRTC d'Alanya EST le `callId`, donc le pont se fait de lui-même au
 * décrochage. Rien à réimplémenter : la mise en tampon quand l'agent n'a pas de
 * socket, le push quand son application est fermée, l'historique et la détection
 * « déjà en ligne » suivent tout seuls.
 *
 * L'agent voit le VRAI appelant — c'est lui qu'il prend en charge, et il ne
 * pourrait rien tracer d'un correspondant anonyme. `ivrFrom` porte le nom du
 * centre pour la mention « via … » sur son écran de sonnerie ; c'est un champ
 * additif, qu'un client qui l'ignore traite comme un appel ordinaire.
 */
async function sonnerAgentIvr(session, agentId) {
  const [appelant, call] = await Promise.all([
    prisma.user.findUnique({
      where: { id: session.appelantId },
      select: { nom: true, pseudo: true, publicNumber: true, avatarUrl: true },
    }),
    prisma.call.findUnique({
      where: { id: session.callId },
      select: { convId: true, type: true },
    }),
  ]);
  if (!call) return false;

  await prisma.callParticipant.upsert({
    where: { callId_userId: { callId: session.callId, userId: agentId } },
    update: { leftAt: null, joinedAt: null },
    create: { callId: session.callId, userId: agentId, joinedAt: null },
  });

  const nomAppelant = appelant ? nomAffichage(appelant) : "Appel";
  const charge = {
    type: "incoming_call",
    callId: session.callId,
    convId: call.convId,
    callType: call.type,
    callerId: session.appelantId,
    callerName: nomAppelant,
    callerAvatarUrl: appelant?.avatarUrl ?? null,
    // Un appel à deux, et non un groupe : le numéro du centre est participant en
    // base mais ne décrochera jamais. Annoncer un groupe donnerait à l'agent une
    // interface à plusieurs pour une conversation en tête-à-tête.
    isGroup: false,
    groupName: null,
    memberCount: 2,
    ivrFrom: session.nomCentre,
  };
  if (!sendTo(agentId, charge)) bufferPendingCall(agentId, charge);
  if (isPushEnabled()) {
    await pushIncomingCall(prisma, {
      recipientId: agentId,
      callId: session.callId,
      convId: call.convId,
      callerName: `${nomAppelant} (via ${session.nomCentre})`,
      callType: call.type,
      isGroup: false,
      groupName: null,
    });
  }
  return true;
}

/**
 * Ramène l'appelant au menu après un agent injoignable, occupé ou qui refuse.
 *
 * ⚠️ C'EST CE QUI DISTINGUE UN STANDARD D'UN JOUET. Un agent indisponible ne
 * doit jamais raccrocher au nez de l'appelant : celui-ci revient au menu et
 * choisit autre chose, comme sur n'importe quel vrai standard téléphonique.
 */
async function ivrRetourAuMenu(session, { code, message }) {
  if (session.minuteur) clearTimeout(session.minuteur);
  session.minuteur = null;
  const agentId = session.agentId;
  session.agentId = null;
  session.agentLabel = null;
  session.etape = "menu";

  // L'agent sort de l'appel. Sans cette ligne, il resterait « occupé » aux yeux
  // de tous les autres appelants alors qu'il ne parle à personne — et le
  // standard le sauterait à chaque nouvelle demande.
  if (agentId) {
    try {
      await prisma.callParticipant.updateMany({
        where: { callId: session.callId, userId: agentId, leftAt: null },
        data: { leftAt: new Date() },
      });
    } catch (e) {
      console.error("[ivr] sortie de l'agent:", e?.message ?? e);
    }
  }

  envoieAAppelant(session, {
    type: "ivr_error",
    callId: session.callId,
    code,
    retry: true,
    message,
    // Le menu est renvoyé avec l'erreur : une touche a pu devenir disponible ou
    // indisponible depuis l'ouverture, et l'écran doit se remettre à jour sans
    // avoir à redemander quoi que ce soit.
    options: optionsPubliques(session.options),
  });
  armerMinuteurMenu(session);
}

/**
 * L'agent ne décroche pas → retour au menu, et on arrête sa sonnerie.
 *
 * L'annulation chez l'agent n'est pas cosmétique : sans elle son téléphone
 * continuerait de sonner jusqu'à son propre minuteur, et il décrocherait sur un
 * appelant déjà reparti dans le menu.
 */
function armerMinuteurAgent(session) {
  if (session.minuteur) clearTimeout(session.minuteur);
  session.minuteur = setTimeout(async () => {
    const vivante = sessionsIvr.get(session.callId);
    if (!vivante || vivante.etape !== "sonnerie") return;
    const agentId = vivante.agentId;
    const libelle = vivante.agentLabel;
    if (agentId) {
      sendTo(agentId, {
        type: "call_state",
        callId: vivante.callId,
        state: "cancelled",
        from: vivante.appelantId,
        userId: vivante.appelantId,
        displayName: null,
      });
      if (isPushEnabled()) {
        await pushCallCancelled(prisma, {
          recipientId: agentId,
          callId: vivante.callId,
        }).catch(() => {});
      }
    }
    await ivrRetourAuMenu(vivante, {
      code: "no_answer",
      message: `${libelle} n'a pas répondu. Choisissez un autre service.`,
    });
  }, DELAI_SONNERIE_AGENT_MS);
}

/**
 * L'appelant tape une touche.
 *
 * Trois refus possibles, et ils ne disent PAS la même chose :
 *
 *  - `invalid` — la touche ne correspond à rien ;
 *  - `unavailable` — le service existe, l'invite vocale l'annonce, mais aucun
 *    agent ne le dessert encore. Répondre « choix invalide » à quelqu'un qui
 *    vient d'entendre « tapez 2 » serait un mensonge ;
 *  - `busy` — tous les agents du service sont en ligne.
 *
 * Les trois ramènent au menu (`retry: true`), aucun ne raccroche.
 */
async function handleIvrDtmf(ws, msg) {
  const { callId, digit } = msg;
  const session = sessionIvr(callId);

  // Identité vérifiée par le JETON porté par la socket, jamais par la charge
  // utile : sans cela, n'importe qui connaissant un identifiant d'appel pourrait
  // faire sonner les agents d'un centre.
  if (!session || session.appelantId !== ws.userId) return;
  // Une touche pendant l'attente est ignorée en silence — l'agent sonne déjà.
  if (session.etape !== "menu") return;

  const touche = Number(digit);
  const option = session.options.find((o) => o.digit === touche);
  const menu = optionsPubliques(session.options);

  if (!option) {
    return envoieAAppelant(session, {
      type: "ivr_error",
      callId,
      code: "invalid",
      retry: true,
      message: "Ce choix ne correspond à aucun service.",
      options: menu,
    });
  }
  if (option.agentIds.length === 0) {
    return envoieAAppelant(session, {
      type: "ivr_error",
      callId,
      code: "unavailable",
      retry: true,
      message: `${option.label} n'est pas encore disponible.`,
      options: menu,
    });
  }

  const agentId = await choisirAgentLibre(prisma, option.agentIds);
  if (!agentId) {
    return envoieAAppelant(session, {
      type: "ivr_error",
      callId,
      code: "busy",
      retry: true,
      message: `${option.label} est en ligne. Choisissez un autre service.`,
      options: menu,
    });
  }

  // ⚠️ L'ÉTAT BASCULE AVANT LE MOINDRE ENVOI. Un double appui — sur un réseau
  // lent, l'utilisateur insiste — lancerait sinon deux sonneries d'agent pour
  // une seule intention. Le verrouillage du clavier côté client est un confort ;
  // la garantie est ici.
  if (session.minuteur) clearTimeout(session.minuteur);
  session.minuteur = null;
  session.agentId = agentId;
  session.agentLabel = option.label;
  session.etape = "sonnerie";

  envoieAAppelant(session, {
    type: "ivr_hold",
    callId,
    digit: touche,
    label: option.label,
    holdUrl: session.urlAttente,
  });

  if (!(await sonnerAgentIvr(session, agentId))) {
    return ivrRetourAuMenu(session, {
      code: "offline",
      message: `${option.label} est momentanément injoignable.`,
    });
  }
  armerMinuteurAgent(session);
  console.log(`[ivr] touche ${touche} « ${option.label} » — appel ${callId}, agent sollicité`);
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

  /**
   * Verrou : un appareil qui n'a pas la main ne peut pas appeler ce
   * correspondant. On refuse ici plutot que de laisser sonner — l'appel a beau
   * etre cree cote REST, sans cette diffusion personne ne sonne, et
   * l'initiateur recoit l'etat qui le lui dit.
   */
  const monVerrou = await detenteurDuVerrou(call.convId, ws.userId);
  // On ne refuse que si l'on sait a quel poste on parle. Une socket qui ne
  // s'est pas annoncee — le mobile aujourd'hui — pourrait etre le detenteur
  // lui-meme : la refuser l'empecherait d'appeler depuis SA propre reservation.
  if (monVerrou !== null && ws.appareilId != null && monVerrou !== ws.appareilId) {
    ws.send(
      JSON.stringify({
        type: "call_state",
        callId,
        state: "locked_elsewhere",
        convId: call.convId,
      }),
    );
    return;
  }

  const targets = await callParticipantIds(callId);

  /**
   * AIGUILLAGE CENTRE D'APPELS — avant tout le reste, et rien de plus.
   *
   * C'est ici que se décide « personne ne sonne », donc c'est ici que
   * l'aiguillage doit tomber : `POST /api/calls` a déjà créé l'appel et ses
   * participants, mais aucun téléphone n'a encore bougé.
   *
   * Uniquement en tête-à-tête. Un appel de groupe qui compterait un centre parmi
   * ses membres n'est pas un appel vers un standard : le faire basculer
   * priverait les autres membres de leur appel.
   *
   * ⚠️ Le CLIENT NE SAIT PAS qu'il appelle un centre, et c'est délibéré. Aucun
   * pré-contrôle avant l'appel : ce serait un aller-retour réseau devant chaque
   * appel, une règle métier dupliquée chez trois clients, et à terme une route
   * publique qui laisserait énumérer l'annuaire. Le serveur décide, le client
   * bascule d'écran quand il reçoit `ivr_menu` au lieu d'une sonnerie.
   */
  const autresQueMoi = targets.filter((uid) => uid !== ws.userId);
  if (autresQueMoi.length === 1) {
    const cible = await prisma.user.findUnique({
      where: { id: autresQueMoi[0] },
      select: {
        id: true,
        typeCompte: true,
        nom: true,
        pseudo: true,
        publicNumber: true,
        avatarUrl: true,
        // Départage les lignes `vocal` quand un même numéro en porte plusieurs :
        // l'unicité de cette table est (entreprise, centre), pas le centre seul.
        idCompany: true,
      },
    });
    if (estCompteCentre(cible)) {
      /**
       * ⚠️ GARDE DE RÉ-ENTRÉE. `call_ring` n'arrive pas forcément une seule
       * fois : le client web le RENVOIE à 4 s et à 10 s, au cas où le premier se
       * serait perdu pendant une reconnexion du WebSocket. Inoffensif pour un
       * appel ordinaire — le destinataire ignore un appel déjà connu — mais
       * dévastateur ici : le menu repartirait de zéro, l'invite se rejouerait
       * par-dessus, et surtout un agent déjà sollicité se retrouverait à sonner
       * pour une session que plus personne ne référence.
       */
      if (sessionsIvr.has(callId)) return;
      await ouvrirSessionIvr(ws, call, cible);
      return; // personne ne sonne
    }
  }

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
    /**
     * Verrou de conversation : si un poste du compte destinataire a reserve
     * cette conversation, lui seul sonne. Les autres appareils ne recoivent ni
     * la sonnerie, ni le push — ils suivent le fil en lecture et retrouvent
     * leurs droits des que le detenteur rend la main.
     */
    const detenteur = await detenteurDuVerrou(call.convId, uid);

    // On vise d'abord le poste qui detient la reservation.
    let delivered = detenteur ? sendToAppareil(uid, detenteur, payload) : false;

    /*
     * ⚠️ CORRECTIF DU 06/08/2026 — un verrou RESERVE un appel, il ne doit pas
     * le faire disparaitre.
     *
     * La version precedente sautait a la fois la mise en attente ET le push des
     * qu'un verrou existait, meme quand le detenteur n'avait pas ete joint.
     * L'appel devenait alors totalement silencieux : pas de sonnerie, pas de
     * notification, et l'appelant restait sur « connexion en cours » jusqu'a
     * l'expiration. Constate sur les appels Web -> Android.
     *
     * Le ciblage repose sur `ws.appareilId`, renseigne par le message
     * d'annonce `{type:"device"}`. Or l'APPLICATION MOBILE NE L'ENVOIE PAS
     * ENCORE : `sendToAppareil` ne trouve donc jamais sa cible sur mobile, et
     * la reservation transformait chaque appel verrouille en trou noir. Tant
     * que le mobile n'annonce pas son identite, ce repli est ce qui fait
     * sonner les telephones.
     *
     * La reservation reste honoree quand elle PEUT l'etre : si le detenteur
     * est joint, lui seul sonne et aucun push ne part. Sinon on retombe sur le
     * comportement d'avant — mieux vaut sonner sur un poste de trop que pas du
     * tout.
     */
    /*
     * AFFINAGE DU 07/08/2026 — le repli ne vaut que si l'on ne PEUT pas cibler.
     *
     * Le correctif du 06/08 retombait sur « tout le monde sonne » des que le
     * detenteur n'etait pas joint. Sur un compte dont les appareils s'annoncent,
     * cela laissait fuir la reservation : il suffisait que le poste detenteur
     * se mette en veille pour que les autres se remettent a sonner, alors qu'ils
     * ne peuvent ni ecrire ni appeler.
     *
     * On distingue donc deux situations :
     *
     *  - Le compte a au moins une socket identifiee. Le ciblage fonctionne : si
     *    le detenteur ne repond pas, c'est qu'il est absent, et la reservation
     *    tient. Personne d'autre ne sonne. Le verrou expire de lui-meme au bout
     *    de deux minutes sans signe de vie, ce qui rend la main automatiquement
     *    — le silence est donc borne, jamais definitif.
     *
     *  - Aucune socket identifiee (cas du mobile aujourd'hui). On ne sait pas
     *    qui est qui : reserver reviendrait a faire disparaitre l'appel. On
     *    retombe sur le comportement d'avant, exactement comme le voulait le
     *    correctif du 06/08.
     */
    const reservationHonoree = delivered;
    const peutCibler = detenteur !== null && compteIdentifie(uid);

    if (!delivered && !peutCibler) delivered = sendTo(uid, payload);

    // Un appel reserve n'est pas mis en attente : le rejouer plus tard sur un
    // autre poste contournerait la reservation.
    if (!delivered && !peutCibler) bufferPendingCall(uid, payload);

    if (isPushEnabled() && !reservationHonoree && !peutCibler) {
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

/**
 * CENTRE D'APPELS — LE PIÈGE, et il n'est pas celui du guide.
 *
 * Sur une pile où les pairs se désignent par leur numéro de téléphone, masquer
 * l'agent CASSE la connexion : la réponse SDP arrive au nom d'un pair inconnu et
 * le client la jette en silence. Chez nous, l'inverse : la mesh est indexée par
 * `userId`, l'appelant apprend celui de l'agent par `call_state "joined"`, et
 * tout fonctionnerait — en révélant l'agent.
 *
 * C'est donc le MASQUAGE qui impose la réécriture, et non la connexion. Mais la
 * conclusion du guide tient mot pour mot : une identité masquée doit l'être
 * jusqu'au bout de la pile, y compris dans les champs techniques que l'interface
 * n'affiche jamais. À moitié masquée, elle ne casse pas seulement le secret :
 * elle casse le protocole.
 *
 * Les deux camps n'ont pas le même nom pour la même connexion :
 *
 *   | émetteur | croit parler à | reçoit `from` |
 *   |----------|----------------|---------------|
 *   | appelant | LE CENTRE      | le centre     |
 *   | agent    | l'appelant     | l'appelant    |
 *
 * D'où une réécriture ASYMÉTRIQUE : on redirige dans un sens, on renomme dans
 * l'autre. Elle répare deux choses à la fois — l'appariement des pairs chez
 * l'appelant, et l'anonymat, que le seul masquage d'interface laissait fuir à
 * chaque candidat ICE.
 */
function relaisIvr(ws, session, toUserId, callId, signal) {
  if (!session || !session.agentId) return false;

  // APPELANT → il adresse ses signaux AU CENTRE, seul pair qu'il connaisse.
  // On les redirige vers l'agent ; `from` reste intact, l'agent doit voir le
  // vrai appelant, c'est lui qu'il prend en charge.
  if (ws.userId === session.appelantId && toUserId === session.centreId) {
    envoieAuxSocketsDeLAppel(session.agentId, callId, {
      type: "call_signal",
      callId,
      from: session.appelantId,
      signal,
    });
    return true;
  }

  // AGENT → APPELANT : la cible est la bonne, c'est l'expéditeur qu'il faut
  // renommer. Sans cette ligne, le vrai identifiant de l'agent remontait jusqu'à
  // l'appelant à chaque candidat ICE, dans un champ que personne ne regarde.
  if (ws.userId === session.agentId && toUserId === session.appelantId) {
    envoieAuxSocketsDeLAppel(session.appelantId, callId, {
      type: "call_signal",
      callId,
      from: session.centreId,
      signal,
    });
    return true;
  }

  return false;
}

async function handleCallSignal(ws, msg) {
  const { callId, toUserId, signal } = msg;
  if (!callId || !toUserId || !signal) return;

  // Avant le contrôle de participation : l'appelant vise le CENTRE, qui est bien
  // participant, mais c'est l'agent qui doit recevoir. Le chemin est très chaud
  // — des dizaines de candidats ICE par appel — d'où une simple lecture en
  // mémoire, sans requête.
  const session = sessionIvr(callId);
  if (session && relaisIvr(ws, session, toUserId, callId, signal)) {
    if (!session.tracee) {
      session.tracee = true;
      console.log(`[ivr] pont de signalisation actif — appel ${callId}`);
    }
    return;
  }

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

/**
 * Pousse son propre enregistrement à un participant qui vient de QUITTER un
 * appel qui continue sans lui.
 *
 * `diffuseAppelTermine` ne dit rien dans ce cas, et c'est volontaire : l'appel
 * n'est pas terminé, il se poursuit entre les deux autres. Mais pour celui qui
 * sort — le transféreur — il l'est bel et bien. Sans cet envoi, sa liste
 * d'appels et son fil restaient sur « en cours » jusqu'au prochain rechargement
 * complet, et affichaient de nouveau « en cours » puisque le serveur renvoyait
 * le statut global. `serialiseAppelPour` corrige la lecture, ceci corrige le
 * temps réel.
 */
async function pousseDepartParticipant(callId, userId) {
  try {
    const call = await prisma.call.findUnique({
      where: { id: callId },
      include: { participants: { include: { user: true } } },
    });
    if (!call) return;
    // Appel déjà clos pour tout le monde : `diffuseAppelTermine` s'en est chargé.
    if (STATUTS_TERMINAUX.includes(call.status)) return;
    const moi = call.participants.find((p) => p.userId === userId);
    // `leftAt` est posé par `POST /api/calls/:id/leave`. S'il manque, le départ
    // n'a pas été enregistré : ne rien annoncer plutôt qu'annoncer du faux.
    if (!moi?.leftAt) return;

    const conv = call.convId
      ? await prisma.conversation.findUnique({
          where: { id: call.convId },
          select: { isGroup: true, name: true },
        })
      : null;

    sendTo(userId, { type: "call_ended", call: serialiseAppelPour(call, conv, userId) });
  } catch (e) {
    console.error("[ws] pousseDepartParticipant:", e?.message ?? e);
  }
}

async function handleCallState(ws, msg) {
  const { callId, state, userId: joinedUserId, displayName } = msg;
  if (!callId || !state) return;
  const ids = await callParticipantIds(callId);
  if (!ids.includes(ws.userId)) return;

  /**
   * CENTRE D'APPELS — ce qui vient de l'AGENT ne se propage pas tel quel.
   *
   * Deux cas, et le second est celui qui sépare un standard d'un jouet :
   *
   *  - il DÉCROCHE : la session doit SURVIVRE. C'est elle qui, à partir de
   *    maintenant, route la signalisation et tient l'identité du centre. Seul le
   *    minuteur de sonnerie est annulé ;
   *
   *  - il REFUSE, ou son application se ferme pendant la sonnerie : ne surtout
   *    pas relayer. Un `call_state rejected` fermerait l'écran de l'appelant —
   *    autrement dit le standard lui raccrocherait au nez parce qu'un agent est
   *    absent. On le ramène au menu.
   */
  const sessionCourante = sessionIvr(callId);
  if (sessionCourante && ws.userId === sessionCourante.agentId) {
    if (state === "joined" || state === "accepted") {
      if (sessionCourante.minuteur) clearTimeout(sessionCourante.minuteur);
      sessionCourante.minuteur = null;
      sessionCourante.etape = "ponte";
    } else if (
      sessionCourante.etape === "sonnerie" &&
      ["rejected", "declined", "ended", "cancelled"].includes(state)
    ) {
      ws.callIdActif = null;
      await ivrRetourAuMenu(sessionCourante, {
        code: "declined",
        message: `${sessionCourante.agentLabel} n'est pas disponible. Choisissez un autre service.`,
      });
      return;
    }
  }

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
  // ⚠️ UNE CHARGE PAR DESTINATAIRE. C'est ici que l'appelant apprend qui vient
  // de décrocher : diffuser la même charge à tous lui livrerait l'identifiant de
  // l'agent, et sa mesh WebRTC s'appuierait dessus. Voir `chargeCallStatePour`.
  for (const uid of ids) {
    sendTo(uid, chargeCallStatePour(sessionCourante, uid, payload));
  }

  /**
   * Session IVR : elle sert au routage de la signalisation, elle doit donc
   * SURVIVRE au décrochage et ne mourir qu'avec l'appel.
   *
   * `left` est traité à part : un agent qui quitte ne referme pas la session —
   * l'appelant, lui, est toujours là. Seul le départ de L'APPELANT y met fin.
   */
  const finPourTous = ["ended", "rejected", "declined", "cancelled"].includes(state);
  if (finPourTous || (state === "left" && sessionIvr(callId)?.appelantId === ws.userId)) {
    fermerSessionIvr(callId);
  }

  // Si l'appel est clos, pousser l'enregistrement COMPLET dans la foulée.
  await diffuseAppelTermine(callId, ids);

  // Départ sans clôture (transfert) : seul celui qui part change d'état.
  if (state === "left") await pousseDepartParticipant(callId, ws.userId);

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

/// Borne haute de la durée prévue d'une réunion. Une valeur absurde envoyée par
/// un client (bug d'arrondi, entier négatif retourné) figerait un minuteur pour
/// tout le monde ; on la refuse plutôt que de l'écrire.
const DUREE_REUNION_MAX_SEC = 24 * 3600;

/**
 * Prolonge la durée prévue d'une réunion en cours.
 *
 * Passe par le WebSocket et non par une route REST : c'est ici que vit la
 * salle, donc le seul endroit d'où l'information atteint tous les participants
 * dans la seconde. Une route HTTP aurait écrit en base sans que personne ne
 * l'apprenne avant son prochain rechargement.
 *
 * ⚠️ ORGANISATEUR SEUL. La durée est le cadre qu'il a posé en créant la
 * réunion ; laisser n'importe qui la repousser lui retirerait ce cadre.
 *
 * La nouvelle durée est calculée par le client qui prolonge (temps déjà écoulé
 * + 15 min), pas ici : le serveur ne sait pas depuis quand CHACUN est connecté,
 * le minuteur affiché courant depuis l'entrée de chacun dans la salle. Il se
 * borne donc à valider et à refuser tout ce qui raccourcirait la réunion.
 */
async function handleMeetingExtend(ws, msg) {
  const { meetingId, duree } = msg;
  if (!meetingId || typeof duree !== "number" || !Number.isFinite(duree)) return;
  const nouvelle = Math.round(duree);
  if (nouvelle <= 0 || nouvelle > DUREE_REUNION_MAX_SEC) return;

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: meetingId },
    select: { idMeeting: true, isEnd: true, idOrganiser: true, duree: true },
  });
  if (!meeting || meeting.isEnd === 1) return;
  if (meeting.idOrganiser !== ws.userId) {
    ws.send(JSON.stringify({
      type: "error",
      message: "Seul l'organisateur peut prolonger la réunion",
      meetingId,
    }));
    return;
  }
  // Ne jamais RACCOURCIR par ce chemin : deux organisateurs sur deux appareils,
  // ou un message rejoué après une reconnexion, ramèneraient la réunion à une
  // durée déjà dépassée et rallumeraient l'alerte chez tout le monde.
  if (nouvelle <= meeting.duree) return;

  await prisma.meeting.update({
    where: { idMeeting: meetingId },
    data: { duree: nouvelle },
  });

  // Diffusé à TOUS, l'organisateur compris : son application n'applique donc
  // pas sa prolongation sur sa seule foi, elle attend la confirmation du
  // serveur — le même chemin pour tout le monde, donc le même minuteur.
  sendToMeeting(meetingId, {
    type: "meeting_extended",
    meetingId,
    duree: nouvelle,
    by: ws.userId,
  });
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

/// Longueur maximale d'un message de salle. Le fil est éphémère et sert à
/// glisser un lien ou une précision pendant qu'on parle : au-delà, c'est une
/// conversation, et elle a son propre écran.
const MESSAGE_REUNION_MAX = 2000;

/**
 * Relaie un message texte aux autres participants de la salle.
 *
 * ÉPHÉMÈRE, ET C'EST VOULU. Rien n'est écrit en base : le fil vit le temps de
 * la réunion et disparaît avec elle, comme dans les autres outils de
 * visioconférence. Persister demanderait de rattacher une vraie conversation à
 * la réunion — donc une migration — pour un fil que personne ne relit.
 *
 * Conséquence assumée : qui arrive en cours de route ne voit pas ce qui a été
 * dit avant. Le serveur ne garde aucun historique à lui renvoyer.
 *
 * L'expéditeur est renvoyé par le serveur, jamais pris du message : un client
 * pourrait sinon écrire sous le nom d'un autre. Même raison pour l'horodatage.
 *
 * Le message part aussi à l'expéditeur — `sendToMeeting` sans exclusion — pour
 * que tout le monde reçoive le même fil dans le même ordre, celui du serveur.
 * L'afficher localement avant confirmation le placerait ailleurs chez lui que
 * chez les autres.
 */
async function handleMeetingMessage(ws, msg) {
  const { meetingId } = msg;
  const texte = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!meetingId || !texte) return;
  if (texte.length > MESSAGE_REUNION_MAX) return;

  // Seuls les gens PRÉSENTS dans la salle écrivent : être invité ne suffit pas,
  // sinon on pourrait alimenter un fil sans y assister.
  const room = meetingRooms.get(meetingId);
  if (!room || !room.has(ws.userId)) return;

  const user = await prisma.user.findUnique({
    where: { id: ws.userId },
    select: { pseudo: true, publicNumber: true },
  });

  sendToMeeting(meetingId, {
    type: "meeting_message",
    meetingId,
    fromUserId: ws.userId,
    displayName: user?.pseudo ?? user?.publicNumber ?? "Participant",
    text: texte,
    sentAt: new Date().toISOString(),
  });
}

/**
 * Main levée : signale qu'on demande la parole, ou qu'on la rend.
 *
 * Relayé, jamais stocké. L'état d'une main vit le temps de la réunion, comme le
 * fil de discussion — le persister obligerait à le nettoyer à la fin, et à
 * gérer le cas d'une main restée levée par une déconnexion brutale.
 *
 * Diffusé à TOUS, l'auteur compris : sa propre main s'allume sur la réponse du
 * serveur et non sur sa seule foi, donc tout le monde voit le même état.
 *
 * Comme pour le chat, l'expéditeur est posé par le serveur : sans cela on
 * lèverait la main d'un autre.
 *
 * Qui arrive en cours de route ne voit pas les mains déjà levées — rien n'est
 * conservé pour le lui dire. Le geste est bref par nature, et une main levée
 * finit par se baisser.
 */
async function handleMeetingHand(ws, msg) {
  const { meetingId } = msg;
  if (!meetingId) return;

  const room = meetingRooms.get(meetingId);
  if (!room || !room.has(ws.userId)) return;

  sendToMeeting(meetingId, {
    type: "meeting_hand",
    meetingId,
    fromUserId: ws.userId,
    levee: msg.levee === true,
  });
}

/// Combien de temps avant le début d'une réunion part le rappel.
const RAPPEL_REUNION_AVANT_MS = 5 * 60 * 1000;

/**
 * Rappelle aux participants qu'une réunion commence dans cinq minutes.
 *
 * Balayé ici et non par une tâche cron du système : ce process tourne déjà en
 * permanence et porte les deux autres balayages (statuts expirés, appels
 * périmés). Une cron de plus serait une pièce à installer, à surveiller et à
 * redémarrer séparément.
 *
 * ⚠️ LA MARQUE EST POSÉE AVANT L'ENVOI, pas après. Si Firebase échoue ou si le
 * process meurt au milieu de la boucle, le pire est qu'un rappel manque — alors
 * que marquer après ferait tout recommencer au balayage suivant, trente
 * secondes plus tard, et notifierait dix fois de suite. Une notification perdue
 * se pardonne, dix notifications identiques non.
 *
 * L'insertion elle-même sert de verrou : `meeting_rappel` a pour clé primaire
 * l'identifiant de la réunion, donc deux balayages concurrents ne peuvent pas
 * envoyer deux rappels, le second échoue sur la contrainte.
 *
 * Le rappel part à TOUT LE MONDE, l'organisateur compris, et sans regarder qui
 * a accepté : quelqu'un qui n'a pas encore répondu à l'invitation est
 * précisément celui à qui le rappel sert le plus.
 */
async function envoieRappelsReunion() {
  try {
    const maintenant = Date.now();
    const reunions = await prisma.meeting.findMany({
      where: {
        isEnd: 0,
        // Strictement à venir, et dans les cinq prochaines minutes. Une réunion
        // déjà commencée n'a pas à être « rappelée » : elle a lieu.
        start_time: {
          gt: new Date(maintenant),
          lte: new Date(maintenant + RAPPEL_REUNION_AVANT_MS),
        },
        rappel: { is: null },
      },
      select: {
        idMeeting: true,
        objet: true,
        start_time: true,
        idOrganiser: true,
        participants: { select: { IDparticipant: true } },
      },
    });

    for (const r of reunions) {
      try {
        await prisma.meetingRappel.create({ data: { idMeeting: r.idMeeting } });
      } catch {
        // Déjà marquée entre la lecture et ici : un autre balayage s'en charge.
        continue;
      }

      // Arrondi à la minute SUPÉRIEURE, et jamais moins d'une : « dans 0
      // minutes » n'a aucun sens, et le balayage tombe rarement pile.
      const minutes = Math.max(
        1,
        Math.ceil((r.start_time.getTime() - Date.now()) / 60000),
      );
      const destinataires = new Set([
        r.idOrganiser,
        ...r.participants.map((p) => p.IDparticipant),
      ]);
      for (const uid of destinataires) {
        await pushMeetingReminder(prisma, {
          recipientId: uid,
          meetingId: r.idMeeting,
          objet: r.objet,
          minutes,
        }).catch((e) =>
          console.error("[ws] rappel de réunion:", e?.message ?? e),
        );
      }
      console.log(
        `[ws] Rappel envoyé pour la réunion ${r.idMeeting} (${destinataires.size} destinataires)`,
      );
    }
  } catch (e) {
    // Un balayage qui échoue ne doit pas emporter le serveur : le suivant
    // repassera trente secondes plus tard, et la fenêtre dure cinq minutes.
    console.error("[ws] envoieRappelsReunion:", e?.message ?? e);
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
  // Rappels de réunion : même cadence que les appels périmés. La fenêtre de
  // rappel dure cinq minutes, un balayage toutes les 30 s la traverse dix fois
  // — aucune réunion ne peut la franchir sans être vue.
  envoieRappelsReunion();
  setInterval(envoieRappelsReunion, 30 * 1000);
  // Éviction des appareils fermés : même cadence. C'est le filet du dernier
  // recours — les deux autres chemins agissent en une seconde — donc 30 s de
  // latence suffisent, là où quinze minutes ne suffisaient pas.
  ejecteLesAppareilsFermes();
  setInterval(ejecteLesAppareilsFermes, 30 * 1000);
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
      if (msg.type === "device") {
        // Annonce d'identite : sans elle, on ne saurait pas quelle socket
        // appartient a quel poste, et le verrou ne pourrait pas viser un
        // appareil precis pour les appels.
        const id = Number(msg.appareilId ?? 0);
        if (Number.isFinite(id) && id > 0) ws.appareilId = id;
      } else if (msg.type === "send") await handleSend(ws, msg);
      else if (msg.type === "conversation_lock") await handleConversationLock(ws, msg);
      else if (msg.type === "read") await handleRead(ws, msg);
      else if (msg.type === "typing") await handleTyping(ws, msg);
      else if (msg.type === "recording") await handleRecording(ws, msg);
      else if (msg.type === "session_revoked") await handleSessionRevoked(ws, msg);
      else if (msg.type === "reaction") await handleReaction(ws, msg);
      else if (msg.type === "call_ring") await handleCallRing(ws, msg);
      else if (msg.type === "call_signal") await handleCallSignal(ws, msg);
      else if (msg.type === "call_state") await handleCallState(ws, msg);
      else if (msg.type === "call_invite") await handleCallInvite(ws, msg);
      else if (msg.type === "ivr_dtmf") await handleIvrDtmf(ws, msg);
      else if (msg.type === "delete_message") await handleDeleteMessage(ws, msg);
      else if (msg.type === "edit_message") await handleEditMessage(ws, msg);
      else if (msg.type === "pin_message") await handlePinMessage(ws, msg);
      else if (msg.type === "set_disappearing") await handleSetDisappearing(ws, msg);
      else if (msg.type === "forward_message") await handleForwardMessage(ws, msg);
      else if (msg.type === "meeting_join") await handleMeetingJoin(ws, msg);
      else if (msg.type === "meeting_leave") await handleMeetingLeave(ws, msg);
      else if (msg.type === "meeting_signal") await handleMeetingSignal(ws, msg);
      else if (msg.type === "meeting_extend") await handleMeetingExtend(ws, msg);
      else if (msg.type === "meeting_message") await handleMeetingMessage(ws, msg);
      else if (msg.type === "meeting_hand") await handleMeetingHand(ws, msg);
    } catch (e) {
      console.error("[ws] erreur de traitement:", e);
      ws.send(JSON.stringify({ type: "error", message: "Erreur serveur", tempId: msg?.tempId }));
    }
  });

  ws.on("close", () => {
    markOfflineIfGone(userId, ws); // hors-ligne + lastSeen si dernière socket

    // Sessions IVR de ce compte : elles n'ont plus de destinataire. Leurs appels
    // sont déjà clos par `markOfflineIfGone` — il reste à retirer la session et
    // surtout son MINUTEUR, qui autrement se réveillerait plus tard et
    // clôturerait un appel du même identifiant.
    if (!isUserOnline(userId)) {
      for (const [callId, session] of sessionsIvr) {
        if (session.appelantId === userId) fermerSessionIvr(callId);
      }
    }
    // On ne libere PAS ses reservations : elles lui appartiennent jusqu'a ce
    // qu'il revienne les rendre. Une deconnexion n'est pas une fin de prise en
    // charge.
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
