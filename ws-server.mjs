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
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { isPushEnabled, pushIncomingCall, pushNewMessage, pushCallCancelled, pushMeetingReminder } from "./push.mjs";
// Mêmes règles de libellé que l'API HTTP — voir l'en-tête de ce fichier pour la
// raison du JavaScript plutôt que du TypeScript.
import {
  serialiseAppelPour,
  STATUTS_TERMINAUX,
  DELAI_SANS_REPONSE_MS,
} from "./src/lib/call-labels.mjs";
import { nomAffichage } from "./src/lib/display-name.mjs";

/**
 * L'ORDRE DES MÉDIAS D'UN MESSAGE — jumeau de `src/lib/media-ordre.ts`.
 *
 * 🔴 Sans tri, les photos d'un envoi multiple arrivent EN DÉSORDRE : le client
 * les téléverse une par une, dans l'ordre choisi, mais `include: { media: true }`
 * ne demande aucun ordre à la lecture et PostgreSQL rend les lignes comme il
 * l'entend.
 *
 * ⚠️ Les deux définitions doivent rester IDENTIQUES. C'est le WebSocket qui sert
 * le temps réel et le REST qui sert le rechargement : deux ordres différents
 * feraient sauter la grille entre l'arrivée du message et sa relecture. Le
 * détail complet est dans le fichier TypeScript, que ce serveur ne peut pas
 * importer (il est en `.mjs`).
 */
const MEDIA_ORDONNE = { orderBy: [{ createdAt: "asc" }, { id: "asc" }] };
import {
  TYPES_STRUCTURES,
  chargeValide,
  apercuStructure,
  apercuMessage,
  tronqueContenu,
  LONGUEUR_MAX_CONTENU,
} from "./src/lib/message-payload.mjs";
import { rafraichirApercuApresEdition } from "./src/lib/apercu-conversation.mjs";
import {
  DELAI_MENU_MS,
  DELAI_SONNERIE_AGENT_MS,
  DELAI_ATTENTE_MAX_MS,
  agentDisponible,
  choisirMusiqueAttente,
  urlsVocalAttente,
  DELAI_LECTURE_MAX_MS,
  estCentreVocal,
  ouvreUnStandard,
  lireMenuCentre,
  lireMenuVocal,
  optionsPubliques,
  urlInviteCentre,
  urlBipEnregistrement,
  TOUCHE_PLAINTE_VOCALE,
  DUREE_PLAINTE_MAX_MS,
} from "./src/lib/ivr.mjs";
import {
  ajouterClientFileWS,
  depilerClientSuivantWS,
  abandonnerFileWS,
} from "./src/lib/queue-ws.mjs";

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

  // Meme regle que partout ailleurs : nom d'abord. Ces deux-la portaient le
  // meme oubli que les reunions, et l'avis de blocage reste dans le fil.
  const [bloqueur, bloque] = await Promise.all([
    prisma.user.findUnique({
      where: { id: bloqueurId },
      select: { nom: true, pseudo: true, publicNumber: true },
    }),
    prisma.user.findUnique({
      where: { id: bloqueId },
      select: { nom: true, pseudo: true, publicNumber: true },
    }),
  ]);

  const charge = JSON.stringify({
    code: "blocked_notice",
    blockerId: bloqueurId,
    blockerName: nomAffichage(bloqueur) ?? "",
    blockedName: nomAffichage(bloque) ?? "",
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
    /*
     * ⚠️ EXCLUT LES APPELS IVR EN COURS (15/08/2026, bug rapporté par le user :
     * des appelants en file d'attente s'arrêtaient avant même les 5 minutes
     * promises). Un appel routé par un standard reste `RINGING` tout le temps
     * qu'il navigue le menu, sonne un agent, ou PATIENTE EN FILE — jusqu'à 5
     * min (`DELAI_ATTENTE_MAX_MS`), largement au-delà des 90 s de ce balayage
     * générique conçu pour les appels ORDINAIRES sans réponse. Sans cette
     * exclusion, ce balayage clôturait en NO_ANSWER des appels parfaitement
     * vivants, gérés par leurs PROPRES minuteurs (`armerMinuteurMenu`,
     * `armerMinuteurAgent`, `armerQueuePolling`) qui les referment déjà
     * proprement le moment venu. Une session IVR disparue (redémarrage du
     * process, qui vide `sessionsIvr`) redevient en revanche une cible légitime
     * : c'est le seul cas où ce filet redevient nécessaire pour un appel IVR.
     */
    const perimesHorsIvr = perimes.filter((c) => !sessionsIvr.has(c.id));
    if (perimesHorsIvr.length === 0) return;
    const ids = perimesHorsIvr.map((c) => c.id);
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
  const { convId, tempId, mediaId, mediaIds } = msg;
  // `let` et non `const` : le contenu est RAMENÉ à la longueur de la colonne
  // plus bas, et c'est la valeur raccourcie qui doit servir partout ensuite —
  // l'écho à l'expéditeur, l'aperçu de la conversation, la notification push.
  // La laisser `const` aurait obligé à trimballer deux variables, et il aurait
  // suffi d'en oublier une pour que l'expéditeur voie un texte que la base ne
  // contient pas.
  let content = msg.content;
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

  /**
   * CONTACT et LOCATION n'ont PAS de média obligatoire : leur charge est du
   * JSON dans `content` (voir `src/lib/message-payload.mjs`). Sans cette
   * exception, la garde ci-dessous les jetait en silence — le pire des
   * comportements, l'expéditeur n'ayant jamais d'accusé et son message restant
   * « en cours d'envoi » pour toujours.
   *
   * Une charge invalide est refusée EXPLICITEMENT, elle : mieux vaut une erreur
   * chez l'expéditeur qu'une ligne que le destinataire ne pourra pas afficher.
   */
  const structure = TYPES_STRUCTURES.has(type);
  if (structure && !chargeValide(type, content ?? null)) {
    ws.send(JSON.stringify({ type: "error", message: "Charge de message invalide", tempId }));
    return;
  }

  /**
   * `message.content` est un VARCHAR(500) depuis le 25/08/2026, et PostgreSQL
   * REFUSE une valeur trop longue au lieu de la couper (erreur 22001).
   *
   * Ce chemin-ci n'a JAMAIS eu de plafond — le schéma zod des routes HTTP ne le
   * traverse pas. C'est ce qui explique le message de 14 866 caractères trouvé
   * en base de dev : sans cette coupe, il partait tel quel vers l'INSERT et
   * chaque message un peu long serait devenu un échec d'envoi silencieux.
   */
  const longueur = tronqueContenu(type, content ?? null);
  if (longueur.refuse) {
    // Charge CONTACT/LOCATION trop longue : la couper détruirait son JSON. On
    // refuse, l'expéditeur le voit tout de suite.
    ws.send(JSON.stringify({ type: "error", message: "Charge de message trop longue", tempId }));
    return;
  }
  content = longueur.contenu;
  if (type !== "TEXT" && !structure && uniqueMediaIds.length === 0) return;
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
    // Ordonné : c'est cette réponse qui dessine la grille en temps réel.
    include: { media: MEDIA_ORDONNE },
  });

  // F10 + F11 : met à jour le dernier message dénormalisé + incrémente unreadCount
  await prisma.conversation.update({
    where: { id: convId },
    data: {
      // Libellé, jamais la charge : un CONTACT ou une LOCATION porte du JSON
      // dans `content`, et cette colonne est affichée telle quelle par les trois
      // clients dans la liste des conversations.
      // ⚠️ `apercuMessage` et non `apercuStructure` : ce dernier ne connaît que
      // CONTACT et LOCATION, si bien qu'un média SANS LÉGENDE retombait sur un
      // `content` vide et laissait la colonne à NULL — la liste affichait alors
      // le dernier APPEL à la place de la photo (user, 18/08/2026).
      lastMessage: apercuMessage(type, content ?? null)?.slice(0, 500) ?? null,
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
    // Aperçu du push : le texte pour un TEXT, le libellé pour un message
    // structuré (« 👤 Jean Dupont »), rien pour un média — `pushNewMessage`
    // pose alors son propre libellé selon le type.
    const preview =
      type === "TEXT" ? (content ?? "").slice(0, 120) : apercuStructure(type, content ?? null);

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
  // Coupé à la longueur de la colonne, comme à l'envoi : sans cela, allonger un
  // message au-delà de 500 caractères ferait échouer l'UPDATE en 22001, et la
  // modification serait perdue sans que rien ne le dise. Seul du TEXTE est
  // modifiable (contrôlé plus bas), il n'y a donc pas de charge JSON à ménager.
  const content = typeof msg.content === "string"
    ? msg.content.trim().slice(0, LONGUEUR_MAX_CONTENU)
    : "";
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

  // Si c'était le dernier message, la LISTE des conversations doit suivre — elle
  // lit un libellé dénormalisé, pas le message. Voir `apercu-conversation.mjs`.
  const apercu = await rafraichirApercuApresEdition(prisma, message, content);

  const recipients = await participantsOf(message.convId);
  for (const uid of recipients) {
    sendTo(uid, {
      type: "message_edited",
      convId: message.convId,
      messageId,
      content,
      editedAt,
      // `null` quand le message modifié n'est PAS le dernier : le client sait
      // alors qu'il n'a rien à changer dans sa liste, au lieu d'avoir à
      // redemander la conversation pour le découvrir.
      lastMessage: apercu,
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
  if (session.pollingInterval) clearInterval(session.pollingInterval);
  // Le plafond de lecture d'un centre vocal. Oublié ici, il survivrait à la
  // session : 30 min plus tard il enverrait un message de fin à un appelant qui
  // a raccroché depuis longtemps, ou pire, en pleine autre communication.
  if (session.minuteurLecture) clearTimeout(session.minuteurLecture);
  session.minuteur = null;
  session.pollingInterval = null;
  session.minuteurLecture = null;

  if (session.etape === "attente" && session.centreId && session.appelantId) {
    abandonnerFileWS(prisma, session.centreId, session.appelantId);
  }

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
    // ⚠️ 15/08/2026 : ce champ manquait ici — chaque écriture dans `file` /
    // `file_historique` retombait sur le repli `?? 1`, et `idcompany = 1`
    // n'existe pas (seuls 2 et 3 existent). Violation de contrainte FK sur
    // CHAQUE appel, avalée par le try/catch de queue-ws.mjs : le flux IVR
    // continuait normalement (musique d'attente, message « en file
    // d'attente ») pendant que les deux tables restaient vides.
    centreCompanyId: centre.idCompany,
    // Posé par `depilerClientSuivantWS` dès qu'un agent prend l'appel — c'est
    // ce qui permet au client de noter la communication à la fin. Nul tant que
    // l'appel n'a jamais atteint d'agent (abandon, timeout) : on ne demande
    // pas de noter une communication qui n'a pas eu lieu.
    idHist: null,
    nomCentre,
    centrePublicNumber: centre.publicNumber,
    options,
    // Tirée MAINTENANT, pas au moment de la touche : le client la met en cache
    // pendant que l'invite se joue.
    urlAttente: await choisirMusiqueAttente(prisma, centre),
    urlsQueue: await urlsVocalAttente(prisma, centre),
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
    promptLoop: true,
    holdUrl: session.urlAttente,
    holdLoop: true,
    queueUrls: session.urlsQueue,
    queueLoop: true,
    options: optionsPubliques(options),
  });
  console.log(`[ivr] menu ouvert — appel ${call.id}, centre ${nomCentre}, ${options.length} service(s)`);
}

/**
 * Ouvre un CENTRE VOCAL : personne ne sonne, et personne ne sonnera jamais.
 *
 * Miroir de [ouvrirSessionIvr], réduit à ce qu'un centre vocal utilise
 * réellement. Ce qui en est ABSENT est aussi délibéré que ce qui y figure :
 *
 *  - pas de musique d'attente ni de `vocal_attente` — on n'attend rien ni
 *    personne, l'appui joue le son immédiatement ;
 *  - pas de `centreCompanyId` pour la file : aucune écriture dans `file` ni
 *    `file_historique`, ces tables décrivent des clients à mettre en relation
 *    avec un agent. Un centre vocal n'en a pas, y écrire fabriquerait des
 *    « clients à rappeler » que personne ne rappellera ;
 *  - pas d'`idHist`, donc pas de demande de notation à la fin : on ne note pas
 *    un message enregistré ;
 *  - pas de réécriture d'anonymat : il n'y a aucun agent dont l'identité
 *    pourrait fuir.
 *
 * `mode: "vocal"` voyage jusqu'au client, qui en a besoin pour son écran (un
 * bouton « Retour à l'accueil » plutôt qu'une mise en relation). Un client plus
 * ancien qui ignore le champ affichera le pavé et enverra ses touches — le
 * serveur, lui, répondra `ivr_play` : dégradé, jamais cassé.
 */
async function ouvrirSessionVocale(ws, call, centre) {
  const nomCentre = nomAffichage(centre) ?? centre.publicNumber;
  const options = await lireMenuVocal(prisma, centre);

  if (options.length === 0) {
    sendTo(ws.userId, {
      type: "ivr_error",
      callId: call.id,
      code: "no_service",
      retry: false,
      message: `${nomCentre} n'a aucun menu disponible pour le moment.`,
    });
    await cloreAppelIvr(call.id);
    return;
  }

  // Même raison qu'au centre d'appels : une session résiduelle sur le même
  // identifiant ne doit pas emporter le nouvel appel avec elle.
  fermerSessionIvr(call.id);

  const session = {
    callId: call.id,
    convId: call.convId,
    appelantId: ws.userId,
    centreId: centre.id,
    centreCompanyId: centre.idCompany,
    nomCentre,
    centrePublicNumber: centre.publicNumber,
    options,
    mode: "vocal",
    etape: "menu",
    minuteur: null,
    // Armé seulement pendant une lecture, et le seul minuteur qui puisse
    // refermer la session tant qu'un son tourne en boucle.
    minuteurLecture: null,
    // La touche en cours de lecture, ou nulle hors de cet état. Sert à ignorer
    // un ré-appui sur la touche DÉJÀ en train de jouer : le son boucle, le
    // relancer le ferait repartir du début sans que l'appelant l'ait demandé.
    toucheEnLecture: null,
    // Jamais posés pour un centre vocal — déclarés pour que les chemins de
    // sortie partagés (`fermerSessionIvr`, `handleCallState`) trouvent la même
    // forme d'objet que pour un centre d'appels.
    agentId: null,
    agentLabel: null,
    idHist: null,
  };
  sessionsIvr.set(call.id, session);
  armerMinuteurMenu(session);

  ws.callIdActif = call.id;

  await envoyerMenuVocal(session, centre);
  console.log(
    `[ivr] menu VOCAL ouvert — appel ${call.id}, centre ${nomCentre}, ${options.length} touche(s)`,
  );
}

/**
 * Envoie (ou renvoie) le menu d'accueil d'un centre vocal.
 *
 * Extrait parce qu'il sert DEUX FOIS, et que les deux doivent être identiques :
 * à l'ouverture, et au retour à l'accueil demandé par l'appelant. Le client
 * rejoue l'invite en boucle sur réception d'`ivr_menu` — c'est ce qui fait que
 * « Retour à l'accueil » n'a besoin d'aucun message dédié ni d'aucun code de
 * lecture supplémentaire côté client : il réemprunte un chemin déjà éprouvé sur
 * device.
 *
 * ⚠️ `promptUrl` est relu à chaque envoi et non mémorisé : la plateforme peut
 * changer l'invite pendant l'appel, et surtout une lecture qui aurait échoué à
 * l'ouverture a une seconde chance ici.
 */
async function envoyerMenuVocal(session, centre) {
  envoieAAppelant(session, {
    type: "ivr_menu",
    mode: "vocal",
    callId: session.callId,
    convId: session.convId,
    centerId: session.centreId,
    centerName: session.nomCentre,
    centerNumber: session.centrePublicNumber,
    centerAvatarUrl: centre?.avatarUrl ?? null,
    promptUrl: await urlInviteCentre(prisma, {
      id: session.centreId,
      publicNumber: session.centrePublicNumber,
      idCompany: session.centreCompanyId,
    }),
    promptLoop: true,
    // Ni musique d'attente ni file : un centre vocal ne fait patienter personne.
    // Envoyés explicitement à `null`/vide plutôt qu'omis, pour qu'un client qui
    // réutilise une session précédente ne conserve pas les URL de la sienne.
    holdUrl: null,
    queueUrls: [],
    options: optionsPubliques(session.options),
  });
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
    // Alanya ID du centre, ajouté le 15/08/2026 : `ivrFrom` ne portait que le
    // nom, illisible pour une requête. Sert au client à interroger
    // /api/queue/live et /api/queue/history?centerAlanyaID=… depuis l'écran
    // d'appel de l'agent (tiroir « Liste d'attente »). Additif, comme
    // `ivrFrom` — un client qui l'ignore n'est pas affecté.
    ivrFromId: session.centreId,
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
 * Le CENTRE est-il libre pour prendre CET appel comme son propre agent
 * (touche 0 implicite, voir `lireMenuCentre`) ?
 *
 * `agentDisponible` seul ne peut pas répondre : le centre est
 * `callParticipant` de CHAQUE appel qui compose son numéro — la ligne posée
 * par `POST /api/calls` avant même que l'IVR décide où router, et rien ne la
 * referme tant que l'appel dure (voir `sonnerAgentIvr`, qui la RÉUTILISE via
 * upsert plutôt que d'en créer une seconde). Une lecture brute de
 * `callParticipant` déclarerait donc le centre occupé dès qu'UN SEUL appel
 * entre sur la ligne — y compris un appelant qui navigue encore dans le menu,
 * ou qui parle à un agent réel via une AUTRE touche.
 *
 * La session IVR en mémoire (`sessionsIvr`) fait la différence : elle seule
 * sait QUEL appel a réellement choisi le centre comme agent
 * (`session.agentId === centreId`, posé au moment de sonner). Une ligne
 * `callParticipant` sans session associée n'est pas un artefact de routage —
 * le centre est alors occupé pour une raison hors standard (il a par exemple
 * appelé quelqu'un lui-même, en utilisant son compte comme un utilisateur
 * ordinaire).
 */
async function centreIvrDisponible(prisma, centreId) {
  const lignes = await prisma.callParticipant.findMany({
    where: {
      userId: centreId,
      leftAt: null,
      call: { status: { in: ["RINGING", "ONGOING"] } },
    },
    select: { callId: true },
  });
  for (const { callId } of lignes) {
    const autreSession = sessionIvr(callId);
    if (!autreSession || autreSession.agentId === centreId) return false;
  }
  return true;
}

/**
 * `choisirAgentLibre` de ivr.mjs, adapté au pool qui peut contenir le CENTRE
 * lui-même (touche 0 implicite). Les vrais agents passent par
 * `agentDisponible`, inchangé ; seul le candidat `centreId` passe par
 * `centreIvrDisponible`, ci-dessus.
 */
async function choisirAgentIvrLibre(prisma, agentIds, centreId) {
  for (const id of agentIds) {
    const libre =
      id === centreId
        ? await centreIvrDisponible(prisma, centreId)
        : await agentDisponible(prisma, id);
    if (libre) return id;
  }
  return null;
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
function armerQueuePolling(session, option, touche) {
  if (session.pollingInterval) clearInterval(session.pollingInterval);
  session.pollingInterval = setInterval(async () => {
    const vivante = sessionsIvr.get(session.callId);
    if (!vivante || vivante.etape !== "attente") {
      if (session.pollingInterval) clearInterval(session.pollingInterval);
      session.pollingInterval = null;
      return;
    }

    if (Date.now() - (vivante.debutAttente ?? Date.now()) > DELAI_ATTENTE_MAX_MS) {
      if (vivante.pollingInterval) clearInterval(vivante.pollingInterval);
      vivante.pollingInterval = null;
      console.log(`[ivr] attente expirée (5 min) — appel ${vivante.callId}`);
      // ⚠️ 15/08/2026 : sans cet appel, la ligne restait fantôme dans `file` —
      // `ivrRetourAuMenu` fait passer la session en "menu", et l'abandon sur
      // raccrochage de `fermerSessionIvr` ne se déclenche QUE depuis "attente".
      // Sans clôture ici, ce client n'aurait jamais existé pour /api/queue/history
      // ni pour la vue « clients à rappeler ».
      await abandonnerFileWS(prisma, vivante.centreId, vivante.appelantId, "TIMEOUT");
      await ivrRetourAuMenu(vivante, {
        code: "busy_timeout",
        message: `${option.label} est toujours occupé. Veuillez choisir un autre service.`,
      });
      return;
    }

    const agentLibreId = await choisirAgentIvrLibre(prisma, option.agentIds, vivante.centreId);
    if (!agentLibreId) return;

    if (vivante.pollingInterval) clearInterval(vivante.pollingInterval);
    vivante.pollingInterval = null;

    vivante.agentId = agentLibreId;
    vivante.agentLabel = option.label;
    vivante.etape = "sonnerie";

    // Capturé : c'est ce idHist que le client notera à la fin de l'appel
    // (voir le message `queue_rating_available` envoyé à la clôture de la
    // session, plus bas dans handleCallState).
    const depile = await depilerClientSuivantWS(prisma, vivante.centreId, agentLibreId, vivante.appelantId, vivante.centreCompanyId, option.idService ?? null);
    vivante.idHist = depile?.idHist ?? null;

    envoieAAppelant(vivante, {
      type: "ivr_hold",
      callId: vivante.callId,
      digit: touche,
      label: option.label,
      nomService: option.nomService ?? null,
      holdUrl: vivante.urlAttente,
    });

    if (!(await sonnerAgentIvr(vivante, agentLibreId))) {
      return ivrRetourAuMenu(vivante, {
        code: "offline",
        message: `${option.label} est momentanément injoignable.`,
      });
    }
    armerMinuteurAgent(vivante);
    console.log(`[ivr] file d'attente : agent ${agentLibreId} attribué automatiquement à l'appel ${vivante.callId}`);
  }, 4000);
}

/**
 * L'appelant tape une touche d'un CENTRE VOCAL : on joue le son, point.
 *
 * Aucun agent à chercher, donc aucune file, aucune sonnerie, aucun minuteur de
 * décrochage. Les deux refus possibles reprennent mot pour mot la sémantique du
 * centre d'appels — `invalid` pour une touche qui n'existe pas, `unavailable`
 * pour une touche annoncée dont le son est introuvable — parce que l'appelant
 * ne fait pas la différence entre les deux sortes de standard et n'a pas à la
 * faire.
 *
 * ⚠️ LE SON TOURNE EN BOUCLE (décision du user, 18/08/2026). Trois conséquences
 * qui tiennent toutes dans cette fonction :
 *  - le minuteur de 60 s du menu est COUPÉ : l'appelant écoute, il n'est pas
 *    inactif, et une boucle n'arrive jamais à sa fin pour le réarmer ;
 *  - il est remplacé par le plafond de sécurité, seul moyen de refermer une
 *    session dont plus personne ne s'occupe ;
 *  - un ré-appui sur la touche DÉJÀ en lecture est ignoré. Sans cette garde, il
 *    ferait repartir le son du début, ce que personne n'a demandé — et c'est
 *    exactement le geste qu'on fait quand on croit que « ça n'a pas marché ».
 */
async function handleIvrDtmfVocal(session, touche) {
  // 🔴 LA TOUCHE 0 EST RÉSERVÉE À LA PLAINTE VOCALE, avant toute autre lecture.
  //
  // Elle était libre : vérifié en production le 20/08/2026, `center_audio` ne
  // porte que les touches 1 à 6. Elle le reste par CONVENTION — si la plateforme
  // y dépose un son un jour, il sera ignoré, et un avertissement le dira. Un
  // comportement qui dépend de la présence d'une ligne serait imprévisible pour
  // l'appelant, qui entend toujours la même annonce.
  if (touche === TOUCHE_PLAINTE_VOCALE) {
    if (session.options.some((o) => o.digit === TOUCHE_PLAINTE_VOCALE)) {
      console.warn(
        `[ivr] centre ${session.nomCentre} : un son est configuré sur la touche 0, IGNORÉ — cette touche enregistre les plaintes.`,
      );
    }
    return ouvrirEnregistrementPlainte(session);
  }

  const option = session.options.find((o) => o.digit === touche);
  const menu = optionsPubliques(session.options);

  if (!option) {
    return envoieAAppelant(session, {
      type: "ivr_error",
      callId: session.callId,
      code: "invalid",
      retry: true,
      message: "Ce choix ne correspond à aucune option.",
      options: menu,
    });
  }
  if (option.audioUrl == null) {
    return envoieAAppelant(session, {
      type: "ivr_error",
      callId: session.callId,
      code: "unavailable",
      retry: true,
      message: `${option.nomService ?? option.label} n'est pas disponible pour le moment.`,
      options: menu,
    });
  }

  // Déjà en train de jouer CETTE touche : on ne relance rien.
  if (session.etape === "lecture" && session.toucheEnLecture === touche) return;

  if (session.minuteur) clearTimeout(session.minuteur);
  session.minuteur = null;
  session.etape = "lecture";
  session.toucheEnLecture = touche;
  armerPlafondLecture(session);

  envoieAAppelant(session, {
    type: "ivr_play",
    callId: session.callId,
    digit: touche,
    // Les deux libellés sont envoyés pour la même raison qu'à `ivr_hold` : le
    // client afficherait sinon le nom d'une touche en le retrouvant dans une
    // liste d'options qu'un retour à l'accueil peut avoir remplacée entre-temps.
    label: option.label,
    nomService: option.nomService ?? null,
    audioUrl: option.audioUrl,
    // Explicite, et non déduit côté client : c'est le serveur qui décide de la
    // règle de lecture, et elle pourra changer sans nouvel APK.
    loop: true,
  });
  console.log(
    `[ivr] touche ${touche} « ${option.nomService ?? option.label} » — appel ${session.callId}, lecture vocale`,
  );
}

/**
 * L'appelant a tapé 0 : on l'invite à dicter sa plainte.
 *
 * LE SERVEUR NE FAIT QUE DONNER LE DÉPART. Il n'enregistre rien, ne reçoit
 * aucun flux : le micro, le minuteur, la pause et la réécoute vivent sur le
 * téléphone, et le fichier n'arrive qu'à l'envoi, par la route HTTP des médias.
 * C'est ce qui rend la fonction possible sans toucher au transport de l'appel.
 *
 * ⚠️ L'ENREGISTREMENT NE DÉMARRE PAS À L'APPUI, mais À LA FIN DU BIP — demande
 * explicite du user. C'est le CLIENT qui enchaîne, parce que lui seul sait quand
 * la lecture se termine ; le serveur ne connaîtrait ni la durée du fichier ni le
 * temps de mise en cache. Il envoie donc les deux ensemble et laisse faire.
 *
 * ⚠️ `bipUrl` peut être NULLE — variable d'environnement absente, ou URL
 * relative refusée. Le client démarre alors sans annonce plutôt que de rester
 * bloqué : une variable oubliée ne doit jamais rendre la touche inutilisable.
 *
 * Le minuteur du menu est coupé, comme pour une lecture : quelqu'un qui dicte sa
 * plainte n'est pas inactif. Le plafond de sécurité le remplace — sans lui, une
 * session dont l'appelant est parti resterait ouverte indéfiniment.
 */
async function ouvrirEnregistrementPlainte(session) {
  // Ré-appui pendant qu'il enregistre déjà : on ne relance rien, sinon le bip
  // repartirait par-dessus sa voix et le minuteur du client repartirait de zéro.
  if (session.etape === "enregistrement") return;

  if (session.minuteur) clearTimeout(session.minuteur);
  session.minuteur = null;
  session.etape = "enregistrement";
  session.toucheEnLecture = null;
  armerPlafondLecture(session);

  const bipUrl = urlBipEnregistrement();
  envoieAAppelant(session, {
    type: "ivr_record",
    callId: session.callId,
    centerId: session.centreId,
    centerName: session.nomCentre,
    bipUrl,
    // Explicite, et non deviné côté client : la borne pourra changer sans
    // nouvel APK, comme la règle de boucle d'`ivr_play`.
    maxMs: DUREE_PLAINTE_MAX_MS,
  });
  console.log(
    `[ivr] touche 0 — appel ${session.callId}, enregistrement de plainte (bip ${bipUrl ? "présent" : "ABSENT"})`,
  );
}

/**
 * Le plafond de sécurité d'une lecture en boucle — voir `DELAI_LECTURE_MAX_MS`.
 *
 * Referme comme le minuteur du menu : un `ivr_error` sans `call_ended`, pour que
 * le message ait le temps d'être lu avant que le client décide de raccrocher.
 */
function armerPlafondLecture(session) {
  if (session.minuteurLecture) clearTimeout(session.minuteurLecture);
  session.minuteurLecture = setTimeout(async () => {
    const vivante = sessionsIvr.get(session.callId);
    if (!vivante || vivante.etape !== "lecture") return;
    console.log(`[ivr] lecture vocale plafonnée (30 min) — appel ${vivante.callId}`);
    envoieAAppelant(vivante, {
      type: "ivr_error",
      callId: vivante.callId,
      code: "timeout",
      retry: false,
      message: "Fin de la communication. Rappelez quand vous voudrez.",
    });
    fermerSessionIvr(vivante.callId);
    await cloreAppelIvr(vivante.callId);
  }, DELAI_LECTURE_MAX_MS);
}

/**
 * « Retour à l'accueil » d'un centre vocal.
 *
 * Répond en RENVOYANT `ivr_menu`, et non par un message dédié : le client sait
 * déjà traiter ce message — il rebâtit son écran et rejoue l'invite en boucle —
 * ce qui fait tenir tout le retour à l'accueil sur un chemin déjà éprouvé sur
 * device. Le menu est relu au passage, donc une touche dont le son est devenu
 * résoluble depuis l'ouverture cesse d'être grisée.
 *
 * Sans effet sur un centre d'APPELS : là-bas le retour au menu est décidé par le
 * serveur (agent qui ne répond pas, refus, file expirée), jamais demandé par
 * l'appelant, et laisser ce message y toucher permettrait de sortir d'une mise
 * en relation en cours par un simple bouton.
 */
async function handleIvrBack(ws, msg) {
  const session = sessionIvr(msg?.callId);
  if (!session || session.appelantId !== ws.userId) return;
  if (session.mode !== "vocal") return;
  // ⚠️ « enregistrement » EST ACCEPTÉ AUTANT QUE « lecture ». Sans lui, le
  // bouton « Accueil » serait INERTE pendant qu'on dicte une plainte — le seul
  // état où l'appelant a le plus besoin de pouvoir revenir en arrière, et un
  // bouton sans effet se lit comme une application figée. Les deux étapes
  // partagent d'ailleurs le même plafond de sécurité, donc le même nettoyage.
  if (session.etape !== "lecture" && session.etape !== "enregistrement") return;

  if (session.minuteurLecture) clearTimeout(session.minuteurLecture);
  session.minuteurLecture = null;
  session.toucheEnLecture = null;

  // Relit le menu : une touche peut être devenue disponible depuis l'ouverture.
  const centre = await prisma.user
    .findUnique({
      where: { id: session.centreId },
      select: { id: true, nom: true, pseudo: true, publicNumber: true, avatarUrl: true, idCompany: true },
    })
    .catch(() => null);
  if (centre) {
    const options = await lireMenuVocal(prisma, centre);
    // ⚠️ Un menu devenu VIDE ne remplace pas celui qu'on a : l'appelant se
    // retrouverait devant un pavé sans aucune touche, sans rien pour expliquer
    // pourquoi. Une lecture qui échoue laisse l'écran tel qu'il était.
    if (options.length > 0) session.options = options;
  }

  // Repose l'étape ET le minuteur de 60 s, suspendu pendant toute la lecture.
  armerMinuteurMenu(session);
  await envoyerMenuVocal(session, centre);
  console.log(`[ivr] retour à l'accueil — appel ${session.callId}`);
}

async function handleIvrDtmf(ws, msg) {
  const { callId, digit } = msg;
  const session = sessionIvr(callId);

  if (!session || session.appelantId !== ws.userId) return;

  /*
   * ⚠️ « lecture » EST UN ÉTAT QUI ACCEPTE LES TOUCHES, contrairement à
   * « sonnerie » : le user a demandé de pouvoir passer d'un son à l'autre sans
   * repasser par l'accueil. C'est pour cela que la garde d'étape est écrite par
   * sorte de standard et non une fois pour toutes.
   */
  const touche = Number(digit);
  if (session.mode === "vocal") {
    /*
     * ⚠️ « enregistrement » EST VOLONTAIREMENT ABSENT DE CETTE LISTE, et il ne
     * faut pas l'y ajouter : pendant qu'on dicte une plainte, toute touche est
     * ignorée. L'ajouter ferait perdre l'enregistrement en cours sur un appui
     * distrait — le pavé reste à l'écran, il est facile à toucher. Le retour à
     * l'accueil, lui, passe par `ivr_back`, qui accepte cette étape : c'est la
     * seule sortie, et elle est explicite.
     */
    if (session.etape !== "menu" && session.etape !== "lecture") return;
    return handleIvrDtmfVocal(session, touche);
  }

  if (session.etape !== "menu" && session.etape !== "attente") return;

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

  const agentId = await choisirAgentIvrLibre(prisma, option.agentIds, session.centreId);
  if (!agentId) {
    if (session.minuteur) clearTimeout(session.minuteur);
    session.minuteur = null;
    session.etape = "attente";
    session.optionAttente = option;
    session.toucheAttente = touche;
    session.debutAttente = Date.now();

    const queueUrls =
      session.urlsQueue ??
      (await urlsVocalAttente(prisma, {
        id: session.centreId,
        publicNumber: session.centrePublicNumber,
        idCompany: session.centreCompanyId,
      }));

    envoieAAppelant(session, {
      type: "ivr_error",
      callId,
      code: "busy",
      retry: true,
      inQueue: true,
      message: `${option.label} est actuellement occupé. Votre appel reste en file d'attente.`,
      options: menu,
      queueUrls,
      queueLoop: true,
      holdUrl: session.urlAttente,
      holdLoop: true,
    });

    armerQueuePolling(session, option, touche);
    ajouterClientFileWS(prisma, {
      idCompany: session.centreCompanyId,
      centerAlanyaID: session.centreId,
      idCustomer: session.appelantId,
      idService: option.idService ?? null,
      // Un pool à un seul candidat (systématiquement le cas de la touche 0
      // implicite, [centreId]) désigne son agent sans ambiguïté même en file
      // d'attente. Un pool à plusieurs agents reste `null` : on ne sait pas
      // encore lequel se libérera.
      idAgent: option.agentIds.length === 1 ? option.agentIds[0] : null,
      priorite: 0,
    });
    console.log(`[ivr] tous agents occupés pour ${option.label} — appel ${callId} placé en file d'attente`);
    return;
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

  const depile = await depilerClientSuivantWS(prisma, session.centreId, agentId, session.appelantId, session.centreCompanyId, option.idService ?? null);
  session.idHist = depile?.idHist ?? null;

  envoieAAppelant(session, {
    type: "ivr_hold",
    callId,
    digit: touche,
    label: option.label,
    // Envoyé explicitement plutôt que laissé à retrouver dans le menu par la
    // touche : le client afficherait sinon le nom d'un service à partir d'une
    // liste d'options qu'un retour au menu peut avoir remplacée entre-temps.
    nomService: option.nomService ?? null,
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
      include: { initiator: true, callerMask: true },
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
    /*
     * DEUX SORTES DE STANDARD, UN SEUL AIGUILLAGE.
     *
     * `type_compte = 3` mène à un agent, `= 4` à un son (centre vocal). Tout ce
     * qui précède la bascule leur est commun — le tête-à-tête, la garde de
     * ré-entrée, le fait que personne ne sonne — d'où la question unique. Les
     * séparer aurait dupliqué la garde ci-dessous, c'est-à-dire le seul endroit
     * où un oubli ne se voit pas tout de suite.
     */
    if (ouvreUnStandard(cible)) {
      /**
       * ⚠️ GARDE DE RÉ-ENTRÉE. `call_ring` n'arrive pas forcément une seule
       * fois : le client web le RENVOIE à 4 s et à 10 s, au cas où le premier se
       * serait perdu pendant une reconnexion du WebSocket. Inoffensif pour un
       * appel ordinaire — le destinataire ignore un appel déjà connu — mais
       * dévastateur ici : le menu repartirait de zéro, l'invite se rejouerait
       * par-dessus, et surtout un agent déjà sollicité se retrouverait à sonner
       * pour une session que plus personne ne référence. Vaut tout autant pour
       * un centre vocal, où le second passage couperait le son en cours de
       * lecture pour rouvrir un menu que l'appelant n'a pas redemandé.
       */
      if (sessionsIvr.has(callId)) return;
      if (estCentreVocal(cible)) await ouvrirSessionVocale(ws, call, cible);
      else await ouvrirSessionIvr(ws, call, cible);
      return; // personne ne sonne
    }
  }

  /*
   * RAPPEL « SOUS LE NOM DU CENTRE » (15/08/2026) — `call.callerMask`, quand
   * il existe, remplace l'identité montrée au CALLÉ. `call.initiatorId` reste
   * le vrai agent partout ailleurs (verrous, sonnerie ci-dessus déjà validée
   * par `call.initiatorId === ws.userId`) : seule cette vue-ci est masquée.
   */
  const identiteAffichee = call.callerMask ?? call.initiator;
  const callerName = nomAffichage(identiteAffichee);
  const callerAvatarUrl = identiteAffichee.avatarUrl ?? null;
  const callerIdAffiche = call.callerMaskId ?? ws.userId;
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
      callerId: callerIdAffiche,
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
      include: { callerMask: true, participants: { include: { user: true } } },
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
      include: { callerMask: true, participants: { include: { user: true } } },
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
    // Lu AVANT `fermerSessionIvr`, qui retire la session du registre. Envoyé
    // uniquement si l'appel a réellement atteint un agent (idHist posé par
    // `depilerClientSuivantWS`) : un abandon en file ou un menu jamais résolu
    // n'ont rien à noter. Ciblé sur l'appelant seul — jamais l'agent.
    const sessionAvantFermeture = sessionIvr(callId);
    if (sessionAvantFermeture?.idHist) {
      sendTo(sessionAvantFermeture.appelantId, {
        type: "queue_rating_available",
        callId,
        idHist: sessionAvantFermeture.idHist,
      });
    }
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
    // Meme oubli que dans les reunions : la regle du projet est nomAffichage.
    displayName: nomAffichage(invitee) ?? null,
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
    // Ordonné : recopier les médias en désordre propagerait le défaut au
    // message transféré.
    include: { media: MEDIA_ORDONNE },
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
      include: { media: MEDIA_ORDONNE },
    });

    // Fait remonter la conversation cible (dernier message dénormalisé) et
    // incrémente les non-lus — un message transféré est un vrai nouveau message.
    await prisma.conversation.update({
      where: { id: targetConvId },
      data: {
        updatedAt: new Date(),
        // Même règle qu'à l'envoi : un média transféré sans légende laissait
        // lui aussi la colonne à NULL.
        lastMessage: apercuMessage(original.type, original.content)?.slice(0, 500) ?? null,
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

/// Qui partage son ecran, par salle : identifiant de reunion -> ensemble des
/// identifiants d'utilisateurs en cours de partage.
///
/// Tenu en memoire et non en base, comme la salle elle-meme : un partage
/// n'existe que tant que la socket qui l'emet est ouverte, et le process qui
/// tient les salles est le seul a le savoir. Le persister obligerait a le
/// nettoyer apres un redemarrage, pour une information deja perimee.
///
/// C'est le SEUL etat de salle que le serveur retient — le fil de discussion et
/// les mains levees n'en gardent aucun. La raison : il faut pouvoir dire aux
/// autres que le partage s'arrete quand celui qui partageait s'en va sans le
/// dire, et personne d'autre ne peut le savoir a sa place.
const partagesEcran = new Map();

function meetingParticipants(meetingId) {
  const room = meetingRooms.get(meetingId);
  return room ? [...room.keys()] : [];
}

// ---------------------------------------------------------------------------
// PLAFOND DE PARTICIPANTS
// ---------------------------------------------------------------------------
//
// POURQUOI UN PLAFOND. Les reunions sont un MAILLAGE : aucun serveur ne melange
// les flux, chaque participant ouvre une connexion vers CHACUN des autres et
// encode son flux autant de fois. Le cout ne pese donc pas ici — ce process ne
// voit passer que de la signalisation — mais sur la machine de chaque
// participant. Ce n'est pas une regle commerciale qu'on pourrait assouplir
// « pour cette fois » : au-dela, ce sont les telephones des gens qui lachent.
//
// ⚠️ MIROIR DE src/lib/limites-reunion.ts, ET IL FAUT SAVOIR POURQUOI.
// `npm run ws` lance `node ws-server.mjs` : du node nu, sans TypeScript ni
// bundler. Ce process ne peut pas importer un `.ts`. Les autres regles
// partagees avec l'API ont ete publiees en `.mjs` pour cette exacte raison —
// call-labels.mjs, display-name.mjs, ivr.mjs — et c'est ce qu'il faudra faire
// de celle-ci.
//
// En attendant, la resolution est redite. Ne PAS la redire aurait coute bien
// plus cher : le plafond serait fige aux defauts dans le seul endroit qui le
// fait vraiment respecter, et un superuser qui l'aurait releve verrait sa
// reunion refuser du monde sans qu'aucun ecran ne puisse le lui expliquer.
//
// LE JOUR OU `limites-reunion` existe en `.mjs` : supprimer ce bloc et
// l'importer. D'ici la, les deux bougent ensemble.
const LIMITE_AUDIO_DEFAUT = 9;
const LIMITE_VIDEO_DEFAUT = 6;
const PLAFOND_MIN = 2;
const PLAFOND_MAX_AUDIO = 20;
const PLAFOND_MAX_VIDEO = 12;

/// Le meme code que rendent les routes HTTP. Le texte du serveur n'est jamais
/// traduit et l'application parle neuf langues : c'est ce code, et les chiffres
/// qui l'accompagnent, que le client traduit.
const CODE_SALLE_PLEINE = "MEETING_FULL";

function bornePlafond(valeur, maximum, defaut) {
  if (typeof valeur !== "number" || !Number.isFinite(valeur)) return defaut;
  const entier = Math.trunc(valeur);
  if (entier < PLAFOND_MIN) return PLAFOND_MIN;
  if (entier > maximum) return maximum;
  return entier;
}

/**
 * Plafond applicable a UNE reunion : plafond de l'entreprise de l'organisateur,
 * sinon reglage global, sinon defaut du code.
 *
 * LES LIMITES SUIVENT L'ORGANISATEUR, jamais celui qui pousse la porte. Sinon
 * la meme salle accepterait un septieme participant venu d'une entreprise
 * genereuse et le refuserait a son voisin une seconde plus tard.
 *
 * LE TYPE EST RELU A CHAQUE ENTREE, jamais retenu : une reunion passee de
 * l'audio a la video resserre son plafond sans qu'on ait a y penser.
 *
 * Une lecture par entree dans une salle : c'est une requete indexee, negligeable
 * a cote d'une negociation WebRTC. Aucun cache, deliberement — un plafond
 * baisse doit mordre tout de suite.
 */
async function plafondReunion(idOrganiser, typeMedia) {
  const video = typeMedia === 2;
  try {
    const lignes = await prisma.limiteReunion.findMany({
      where: {
        OR: [
          { idCompany: null },
          { company: { Users: { some: { id: idOrganiser } } } },
        ],
      },
      select: { idCompany: true, maxAudio: true, maxVideo: true },
    });
    // Le plus precis l'emporte : entreprise, puis global.
    const retenue =
      lignes.find((l) => l.idCompany !== null) ??
      lignes.find((l) => l.idCompany === null);
    if (retenue) {
      return video
        ? bornePlafond(retenue.maxVideo, PLAFOND_MAX_VIDEO, LIMITE_VIDEO_DEFAUT)
        : bornePlafond(retenue.maxAudio, PLAFOND_MAX_AUDIO, LIMITE_AUDIO_DEFAUT);
    }
  } catch (e) {
    // Table absente (migration pas encore passee) ou base indisponible une
    // seconde. Refuser toutes les entrees serait pire que le mal ; n'en refuser
    // aucune reviendrait a supprimer le plafond au moment precis ou plus rien
    // ne va. On retombe sur la limite physique, et on le dit.
    console.error(
      "[ws] plafonds de reunion illisibles, defauts appliques:",
      e?.message ?? e,
    );
  }
  return video ? LIMITE_VIDEO_DEFAUT : LIMITE_AUDIO_DEFAUT;
}

/// Meme phrase que celle des routes HTTP (`messageSallePleine`). Avec accents :
/// c'est un texte montre a l'utilisateur, pas un commentaire.
function messageSallePleine(typeMedia, limite) {
  const media = typeMedia === 2 ? "vidéo" : "audio";
  return (
    `Cette réunion ${media} est limitée à ${limite} participants, ` +
    `organisateur compris. Chaque participant envoie son flux à tous les ` +
    `autres : au-delà, la qualité s'effondre pour tout le monde.`
  );
}

/// Diffuse dans une salle. Rend le NOMBRE de sockets effectivement servies.
///
/// Ce compte n'interesse aucun des appelants historiques — ils l'ignorent — mais
/// il est la seule reponse honnete que le pont interne puisse rendre a l'API :
/// « personne n'ecoutait » et « la salle a recu » ne se distinguent pas
/// autrement, et c'est exactement ce qu'on veut lire dans un journal quand un
/// ecran ne se rafraichit pas.
function sendToMeeting(meetingId, payload, excludeUserId) {
  const room = meetingRooms.get(meetingId);
  if (!room) return 0;
  const data = JSON.stringify(payload);
  let servies = 0;
  for (const [uid, ws] of room) {
    if (uid === excludeUserId) continue;
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      servies += 1;
    }
  }
  return servies;
}

async function handleMeetingJoin(ws, msg) {
  const { meetingId } = msg;
  if (!meetingId) return;

  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: meetingId },
    select: { idMeeting: true, isEnd: true, idOrganiser: true, type_media: true },
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
  // L'AUTORISATION AVANT LE PLAFOND : repondre « c'est plein » a quelqu'un qui
  // n'est pas invite lui apprendrait combien de monde se trouve dans une
  // reunion dont il n'a pas a connaitre l'existence.
  if (!participant && meeting.idOrganiser !== ws.userId) {
    ws.send(JSON.stringify({ type: "error", message: "Vous n'êtes pas invité", meetingId }));
    return;
  }

  const plafond = await plafondReunion(meeting.idOrganiser, meeting.type_media);

  // -------------------------------------------------------------------------
  // LA BARRIERE. Ce qui suit est INDIVISIBLE : pas un seul `await` entre le
  // comptage et l'inscription.
  //
  // C'est tout le piege de ce handler. Le code d'origine traversait trois
  // requetes — la reunion, la ligne participant, son ecriture — avant d'inscrire
  // la socket dans la salle. Compter avant ces requetes aurait laisse passer
  // deux arrivees simultanees : chacune aurait vu cinq presents sur six, et la
  // salle en aurait fini avec sept. Node n'execute qu'une chose a la fois, mais
  // il rend la main a CHAQUE `await` — c'est la, et seulement la, que l'autre
  // arrivee se glisse.
  //
  // La place est donc RESERVEE AVANT d'ecrire en base, et non apres : on prend
  // la ressource rare d'abord, on fait le travail ensuite. Si l'ecriture echoue,
  // la reservation est rendue plus bas.
  //
  // ON COMPTE LES SOCKETS DE LA SALLE, pas `connecte` en base. `connecte` ne
  // retombe que sur un depart delibere : une machine qui meurt sans prevenir y
  // garde sa place pour toujours, et quelques plantages suffiraient a fermer une
  // reunion vide. Cette Map-ci se vide toute seule a la fermeture de la socket
  // (voir le `ws.on("close")`), et elle EST le maillage — c'est exactement ce
  // que le plafond veut borner.
  //
  // L'ORGANISATEUR N'EST PAS AU-DESSUS : aucune exception ici. Il est dans la
  // Map comme les autres, donc compte comme les autres.
  //
  // Celui qui est DEJA dans la salle n'est jamais refuse : une reconnexion, ou
  // un second appareil du meme compte, remplace son entree sans rien ajouter au
  // maillage. Le refuser mettrait dehors quelqu'un qui n'etait pas parti.
  const salle = meetingRooms.get(meetingId);
  const dejaDansLaSalle = salle !== undefined && salle.has(ws.userId);
  const presents = salle ? salle.size : 0;
  if (!dejaDansLaSalle && presents >= plafond) {
    ws.send(JSON.stringify({
      type: "error",
      code: CODE_SALLE_PLEINE,
      message: messageSallePleine(meeting.type_media, plafond),
      meetingId,
      plafond,
      actuel: presents,
      typeMedia: meeting.type_media,
    }));
    return;
  }
  // La Map de salle n'est creee qu'une fois la place accordee : un refus ne doit
  // pas laisser derriere lui une salle vide que plus rien ne nettoiera.
  if (!salle) meetingRooms.set(meetingId, new Map());
  meetingRooms.get(meetingId).set(ws.userId, ws);
  // ------------------------------- fin du bloc indivisible -----------------

  try {
    if (participant) {
      await prisma.meetingParticipant.update({
        where: { ID: participant.ID },
        data: { status: 1, connecte: 1, start_time: new Date() },
      });
    } else {
      await prisma.meetingParticipant.create({
        data: { idMeeting: meetingId, IDparticipant: ws.userId, status: 1, connecte: 1, start_time: new Date() },
      });
    }
  } catch (e) {
    // La place reservee doit etre RENDUE : la garder tiendrait un siege pour
    // quelqu'un qui n'est jamais entre, et le plafond se refermerait sur une
    // salle qui n'est pas pleine.
    //
    // Seulement s'il ne l'occupait pas deja : sinon on mettrait dehors, pour
    // une ecriture ratee, quelqu'un dont la participation etait acquise.
    if (!dejaDansLaSalle) {
      const rendue = meetingRooms.get(meetingId);
      if (rendue) {
        rendue.delete(ws.userId);
        if (rendue.size === 0) meetingRooms.delete(meetingId);
      }
    }
    throw e;
  }

  // 🔴 nomAffichage, ET NON pseudo : c'est le nom que TOUTE LA SALLE voit.
  //
  // Ces trois lignes disaient `pseudo ?? publicNumber` et ne selectionnaient
  // meme pas `nom`. La regle du projet est pourtant ecrite depuis longtemps
  // dans display-name.mjs, et ce fichier l'applique deja neuf fois ailleurs :
  // c'etait un oubli, pas un choix. Signale par le user le 26/08/2026 —
  // en reunion, chacun voyait le pseudo des autres au lieu de leur nom.
  const user = await prisma.user.findUnique({
    where: { id: ws.userId },
    select: { nom: true, pseudo: true, publicNumber: true },
  });
  const displayName = nomAffichage(user) ?? "Participant";
  const existing = meetingParticipants(meetingId);

  ws.send(JSON.stringify({
    type: "meeting_joined",
    meetingId,
    participants: existing.filter((id) => id !== ws.userId),
  }));

  // Rattrapage du partage d'ecran en cours, pour lui seul. Sans cela, celui qui
  // arrive au milieu d'une presentation recoit bien la piste video, mais rien ne
  // lui dit que c'est un ecran et non une camera : il l'afficherait comme une
  // vignette de visage. Le meme verbe que l'annonce sert ici, pour que le client
  // n'ait qu'un seul gestionnaire a ecrire.
  for (const auteur of partagesEcran.get(meetingId) ?? []) {
    if (auteur === ws.userId) continue;
    ws.send(JSON.stringify({
      type: "meeting_screen",
      meetingId,
      fromUserId: auteur,
      partage: true,
    }));
  }

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

  // AVANT de le retirer de la salle : il faut que l'arret du partage parte
  // encore par le meme chemin que les autres messages de salle. Et avant
  // `meeting_user_left`, pour que la presentation se referme pendant que son
  // auteur est encore affiche — sinon les autres gardent un plein ecran qui
  // n'appartient plus a personne.
  arretePartageEcran(meetingId, ws.userId);

  const room = meetingRooms.get(meetingId);
  if (room) {
    room.delete(ws.userId);
    if (room.size === 0) meetingRooms.delete(meetingId);
  }

  // La duree ne se calcule qu'au PREMIER depart, exactement comme dans la route
  // REST POST /api/meetings/:id/leave. Ce chemin-ci est pourtant le chemin
  // NOMINAL de la sortie, donc le plus rejoue de tous : le client emet
  // `meeting_leave` sur la socket puis appelle la route HTTP, un onglet se
  // ferme apres un clic sur « Quitter », deux appareils du meme compte partent
  // l'un apres l'autre. A chaque repassage, recalculer depuis start_time
  // ajouterait tout le temps ecoule depuis la vraie sortie — et d'autant plus
  // que le navigateur reste ouvert longtemps derriere.
  //
  // `connecte` fait foi parce que l'entree le remet a 1 en repartant d'un
  // start_time neuf : une seconde participation reelle est donc bien recomptee,
  // seul le rejeu du meme depart est ignore.
  const participant = await prisma.meetingParticipant.findUnique({
    where: { idMeeting_IDparticipant: { idMeeting: meetingId, IDparticipant: ws.userId } },
  });
  if (participant && participant.connecte !== 0) {
    const duree = participant.start_time
      ? Math.round((Date.now() - participant.start_time.getTime()) / 1000)
      : null;
    await prisma.meetingParticipant.update({
      where: { ID: participant.ID },
      // Sans start_time il n'y a rien a calculer : on conserve la duree deja
      // enregistree plutot que d'ecrire null par-dessus.
      data: { connecte: 0, duree: duree ?? participant.duree },
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

  // Meme regle que pour l'entree en salle, et pour la meme raison.
  const user = await prisma.user.findUnique({
    where: { id: ws.userId },
    select: { nom: true, pseudo: true, publicNumber: true },
  });

  sendToMeeting(meetingId, {
    type: "meeting_message",
    meetingId,
    fromUserId: ws.userId,
    displayName: nomAffichage(user) ?? "Participant",
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

/**
 * Partage d'ecran : dit QUI presente, et si la presentation commence ou finit.
 *
 * POURQUOI UN VERBE. La piste video d'un ecran emprunte le meme tuyau que celle
 * d'une camera : `replaceVideoTrack` la substitue chez tous les pairs sans
 * renegocier. Rien dans WebRTC ne dit alors ce qu'elle montre. Sans annonce, un
 * ecran partage arriverait chez les autres comme une vignette de visage,
 * rognee et retournee en miroir. Ce message est la seule chose qui distingue
 * les deux.
 *
 * Calque sur `meeting_hand` : relaye, jamais ecrit dans la conversation, meme
 * nommage des champs, et l'expediteur est pose par le serveur — sans cela on
 * declarerait un partage au nom d'un autre.
 *
 * Diffuse a TOUS, l'auteur compris : sa propre presentation s'affiche sur la
 * reponse du serveur et non sur sa seule foi, donc tout le monde voit le meme
 * etat au meme instant.
 *
 * DEUX PRESENTATEURS A LA FOIS SONT ACCEPTES. Refuser le second serait un
 * mensonge : sa piste d'ecran est deja partie chez les pairs au moment ou il
 * l'annonce, un refus ici ne la rappellerait pas et les autres verraient un
 * ecran presente comme une camera. Le serveur relaie donc les deux et le client
 * tranche ce qu'il met en grand.
 */
async function handleMeetingScreen(ws, msg) {
  const { meetingId } = msg;
  if (!meetingId) return;

  // Seuls les gens PRESENTS dans la salle presentent, comme pour le fil et les
  // mains : etre invite ne suffit pas.
  const room = meetingRooms.get(meetingId);
  if (!room || !room.has(ws.userId)) return;

  if (msg.partage !== true) {
    arretePartageEcran(meetingId, ws.userId);
    return;
  }

  if (!partagesEcran.has(meetingId)) partagesEcran.set(meetingId, new Set());
  partagesEcran.get(meetingId).add(ws.userId);

  sendToMeeting(meetingId, {
    type: "meeting_screen",
    meetingId,
    fromUserId: ws.userId,
    partage: true,
  });
}

/**
 * Eteint le partage d'un participant et l'annonce a la salle.
 *
 * Appele des trois endroits ou un partage peut finir : l'arret demande, le
 * depart annonce, et la socket qui tombe. Un presentateur qui ferme son onglet
 * ne dit rien avant de partir ; sans ce rattrapage, les autres resteraient
 * devant un plein ecran fige que plus personne n'alimente.
 *
 * Le retrait de l'ensemble sert de garde : on n'annonce un arret que si un
 * partage etait bel et bien ouvert, sinon chaque depart de la salle diffuserait
 * un arret pour un partage qui n'a jamais existe.
 */
function arretePartageEcran(meetingId, userId) {
  const partages = partagesEcran.get(meetingId);
  if (!partages || !partages.delete(userId)) return;
  if (partages.size === 0) partagesEcran.delete(meetingId);

  sendToMeeting(meetingId, {
    type: "meeting_screen",
    meetingId,
    fromUserId: userId,
    partage: false,
  });
}

/**
 * L'organisateur demande a un participant de couper son micro ou sa camera.
 *
 * ON NE COUPE PAS UN FLUX A DISTANCE. La piste appartient a l'APPAREIL du
 * participant : rien ici, ni dans WebRTC, ne peut l'eteindre depuis l'exterieur.
 * Ce verbe DEMANDE, et l'application du destinataire obeit. C'est donc un
 * message de protocole et non une commande, et le comportement final tient a ce
 * que le client en fait.
 *
 * COUPE, MAIS NE VERROUILLE PAS. Le participant peut se rallumer aussitot,
 * comme dans Zoom, Meet et Teams. Couper sert a faire taire un micro oublie,
 * pas a bailloner quelqu'un. Un verrou permanent demanderait un etat persistant
 * en base, donc une migration, pour un cas bien plus rare : il pourra s'ajouter
 * plus tard sans rien changer a ce verbe.
 *
 * ⚠️ L'AUTORISATION SE VERIFIE ICI, PAS CHEZ LE CLIENT. Si le bouton grise cote
 * client suffisait, n'importe quel participant forgerait la trame et ferait
 * taire toute la salle. Le serveur relit donc l'organisateur en base a chaque
 * coupure.
 *
 * SILENCE POUR QUI N'A PAS LE DROIT : ni relais, ni message d'erreur — a la
 * difference de `meeting_extend`, qui refuse a voix haute. Une erreur explicite
 * apprendrait a celui qui sonde qu'il a vise juste, et lui dirait au passage de
 * quelles reunions il est organisateur. Le refus se lit ici a l'absence d'effet.
 *
 * DIFFUSE A TOUTE LA SALLE et pas au seul destinataire : les autres doivent
 * pouvoir afficher QUI a ete coupe et PAR QUI, sinon un micro s'eteint sans que
 * personne comprenne pourquoi. L'organisateur compris, comme pour la main levee
 * et le partage : sa propre action s'affiche sur la reponse du serveur et non
 * sur sa seule foi.
 *
 * RIEN N'EST ECRIT EN BASE, deliberement : une coupure est un message, pas un
 * etat. Consequence assumee, la meme que pour les mains levees : qui arrive
 * apres coup ne sait pas qu'un micro a ete coupe. Il le verra simplement
 * eteint, ce qui est vrai.
 */
async function handleMeetingMute(ws, msg) {
  const { meetingId, toUserId } = msg;
  const media = msg.media === "audio" || msg.media === "video" ? msg.media : null;
  if (!meetingId || !toUserId || !media) return;

  // On ne se coupe pas soi-meme par ce chemin : l'organisateur a ses propres
  // boutons, qui agissent sur ses pistes sans passer par le serveur.
  if (toUserId === ws.userId) return;

  // ⚠️ LA GARDE DE SALLE PASSE AVANT LE PREMIER `await`, comme dans la main
  // levee. Les deux presences sont lues sur la meme carte en memoire dans le
  // meme tour de boucle : aucune arrivee ni aucun depart ne peut se glisser
  // entre elles. Interroger la base d'abord laisserait au contraire la salle
  // changer sous nos pieds pendant l'attente — `meeting_join` traverse trois
  // `await` avant d'inscrire sa socket.
  const room = meetingRooms.get(meetingId);
  if (!room || !room.has(ws.userId)) return;

  // Le destinataire doit etre PRESENT et pas seulement invite : couper quelqu'un
  // qui n'est pas entre annoncerait a la salle une coupure que personne ne
  // verrait s'appliquer.
  if (!room.has(toUserId)) return;

  // On ne relit QUE l'organisateur, sans `isEnd` : la presence dans la salle
  // fait deja foi. Une reunion marquee terminee pendant qu'on se dit au revoir
  // laisserait sinon un micro ouvert que plus personne ne pourrait couper.
  const meeting = await prisma.meeting.findUnique({
    where: { idMeeting: meetingId },
    select: { idOrganiser: true },
  });
  if (!meeting || meeting.idOrganiser !== ws.userId) return;

  // Relecture de la salle APRES l'attente : la garde d'en haut porte sur un etat
  // qui date d'avant la requete. Entre-temps l'un des deux a pu partir, ou la
  // salle se vider entierement. Sans cela on annoncerait la coupure d'un absent,
  // au nom d'un absent.
  const salle = meetingRooms.get(meetingId);
  if (!salle || !salle.has(ws.userId) || !salle.has(toUserId)) return;

  sendToMeeting(meetingId, {
    type: "meeting_mute",
    meetingId,
    fromUserId: ws.userId,
    toUserId,
    media,
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

// ---------------------------------------------------------------------------
// PONT INTERNE — comment l'API HTTP atteint une salle ouverte
// ---------------------------------------------------------------------------
//
// LE MANQUE QU'IL COMBLE. L'API Next.js et ce serveur sont DEUX PROCESSUS
// SEPARES. Une route REST qui modifie une reunion — ajouter quelqu'un,
// l'exclure, changer un role — ecrit en base et n'a AUCUN moyen de le dire aux
// sockets ouvertes : elles vivent ici, et ici seulement. Les gens deja dans la
// salle ne voyaient donc bouger ni le compteur ni la liste, et devaient sortir
// et revenir. Le seul pont qui existait, la notification poussee, vise des
// APPAREILS par leur jeton — pas une salle : elle reveille les nouveaux ajoutes
// et personne d'autre.
//
// UN SECOND ECOUTEUR, PAS UNE REFONTE. `new WebSocketServer({ port })` cree son
// propre serveur HTTP et n'expose aucune route. Le restructurer pour y greffer
// un chemin toucherait le demarrage d'un process critique, qui n'a aucune raison
// de changer. On ouvre donc un ecouteur SEPARE, sur son propre port ; le serveur
// WebSocket, lui, demarre exactement comme avant.
//
// 127.0.0.1 ET SEULEMENT LA. L'hote est passe explicitement a `listen`. Sans
// lui, Node ecoute sur TOUTES les interfaces et ce point d'entree — qui diffuse
// dans n'importe quelle salle — devient joignable depuis le reseau.
//
// CONSEQUENCE DE DEPLOIEMENT, a savoir avant de scinder les machines : l'API et
// ce process doivent tourner sur le MEME hote. Le jour ou ils se separent, ce
// n'est pas l'hote d'ecoute qu'il faut elargir, c'est un reseau prive qu'il faut
// poser entre les deux.
//
// GENERAL PAR CONSTRUCTION. Le pont ne connait ni participants, ni roles, ni
// exclusions : il accepte un VERBE et une salle, et relaie. C'est ce qui lui
// permettra de servir l'exclusion et le changement de role sans etre retouche.

/// Le pont ne passe PAS par le reseau : il passe par un FICHIER DE SOCKET.
///
/// La premiere version ouvrait un port sur la boucle locale, protege par un
/// secret partage. Ca marchait, mais ca se payait deux fois : une variable
/// d'environnement de plus a poser — donc a oublier, et le pont ne demarrait
/// pas — et un mot de passe de plus a ne pas laisser fuiter.
///
/// Une socket de fichier supprime les deux. Ce sont les PERMISSIONS DU SYSTEME
/// DE FICHIERS qui autorisent, et elles sont posees par le systeme, pas par
/// nous : seuls les processus tournant sous le meme utilisateur peuvent
/// l'ouvrir. C'est une frontiere plus solide qu'un secret, justement parce
/// qu'un secret partage ne protege pas de ce qui tourne DEJA sur la machine.
///
/// Et il n'y a plus AUCUN port ouvert : l'erreur de configuration qui exposerait
/// le pont au reseau devient impossible a commettre.
///
/// LA LIMITE, a connaitre : l'API et ce serveur doivent vivre sur la MEME
/// machine. C'est le cas aujourd'hui. Le jour ou on les separera, il faudra
/// revenir a un port et a un secret — et ce commentaire dira pourquoi.
const PONT_SOCKET =
  process.env.WS_INTERNAL_SOCKET ?? path.join(process.cwd(), ".ws-interne.sock");

/// DEUX MACHINES : on repasse au reseau, et alors le secret redevient
/// obligatoire.
///
/// Une socket de fichier ne traverse pas le reseau. Le jour ou l'API et ce
/// serveur vivront sur deux machines, il faudra un port — et la, plus rien ne
/// distingue un appelant legitime d'un autre : le secret redevient la seule
/// frontiere.
///
/// La DETECTION, c'est la configuration elle-meme : personne ne peut deviner
/// depuis ce processus si l'API tourne ailleurs. Poser WS_INTERNAL_PORT, c'est
/// declarer qu'on veut le reseau. Rien a poser dans le cas courant.
const PONT_PORT = process.env.WS_INTERNAL_PORT ? Number(process.env.WS_INTERNAL_PORT) : null;
/// Vide quand on ecoute sur toutes les interfaces — ce que le deploiement a deux
/// machines suppose, et qui exige donc le secret.
const PONT_HOTE = process.env.WS_INTERNAL_HOST ?? "127.0.0.1";
const PONT_SECRET = process.env.WS_INTERNAL_SECRET ?? "";
const PONT_ENTETE = "x-alanya-interne";
/// Vrai quand on doit ecouter sur le reseau plutot que sur la socket de fichier.
const PONT_PAR_RESEAU = PONT_PORT !== null;

/// Le seul chemin servi. Tout le reste rend 404.
const PONT_CHEMIN = "/interne/salle/diffuser";

/// Plafond du corps. Le pont ne transporte que des codes et quelques
/// identifiants : au-dela, c'est une erreur ou un abus, et lire sans borne
/// laisserait un seul appelant gonfler la memoire du process.
const PONT_CORPS_MAX = 64 * 1024;

/// Les verbes admis. Restreindre au vocabulaire des salles empeche ce point
/// d'entree de devenir un injecteur de messages quelconques — il ne doit pas
/// pouvoir emettre un `ready` ou un `error` que les clients traitent a part.
/// Reste ouvert a tout `meeting_*` a venir : rien a modifier ici pour
/// l'exclusion ou le changement de role.
const PONT_VERBE = /^meeting_[a-z0-9_]+$/;

/// Comparaison a temps constant. Les deux empreintes font toujours 32 octets :
/// `timingSafeEqual` refuse des longueurs differentes, et comparer les chaines
/// brutes avec `===` laisserait fuir le secret caractere par caractere.
function pontSecretValide(fourni) {
  if (typeof fourni !== "string" || fourni.length === 0) return false;
  const propose = createHash("sha256").update(fourni).digest();
  const attendu = createHash("sha256").update(PONT_SECRET).digest();
  return timingSafeEqual(propose, attendu);
}

function pontRepond(res, code, corps) {
  // Un appelant qui a coupe laisse une reponse morte : ecrire dedans leverait
  // une erreur pour rien.
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(corps);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

/// Lit le corps en refusant de depasser `PONT_CORPS_MAX`.
///
/// Au-dela, on rejette MAIS ON CONTINUE DE LIRE SANS RIEN RETENIR : couper la
/// requete ici empecherait de renvoyer le 413 a l'appelant, qui ne saurait pas
/// pourquoi il a echoue. La memoire, elle, reste bornee — les morceaux
/// suivants sont jetes au fil de l'eau, et la promesse deja rejetee ignore la
/// suite.
function pontLitLeCorps(req) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let taille = 0;
    let depasse = false;
    req.on("data", (morceau) => {
      if (depasse) return;
      taille += morceau.length;
      if (taille > PONT_CORPS_MAX) {
        depasse = true;
        morceaux.length = 0;
        reject(new Error("CORPS_TROP_GROS"));
        return;
      }
      morceaux.push(morceau);
    });
    req.on("end", () => resolve(Buffer.concat(morceaux).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Diffuse un verbe dans une salle, a la demande de l'API.
 *
 * Corps attendu :
 *   { salle: <idMeeting>, type: "meeting_*", donnees?: {...},
 *     exclure?: <userId>, personnes?: [<userId>, ...] }
 *
 * `personnes` sert ceux qui doivent savoir SANS etre dans la salle — un
 * organisateur qui lit la fiche de sa reunion sans y etre entre. Ils sont
 * servis une seule fois : ceux qui sont deja dans la salle l'ont ete par la
 * diffusion.
 *
 * `donnees` est etale AVANT `type` et `meetingId` : l'appelant ne peut donc pas
 * ecraser l'un ni l'autre en glissant une cle du meme nom.
 *
 * AUCUN TEXTE AFFICHABLE n'est fabrique ici, et il ne faut pas commencer : ce
 * qui traverse est un CODE, que le client traduit dans sa langue.
 */
async function pontTraite(req, res) {
  const chemin = (req.url ?? "").split("?")[0];
  if (req.method !== "POST" || chemin !== PONT_CHEMIN) {
    pontRepond(res, 404, { erreur: "NOT_FOUND" });
    return;
  }
  // SUR LA SOCKET DE FICHIER, rien a verifier : l'atteindre suppose deja de
  // pouvoir ouvrir son fichier, ce que le systeme n'autorise qu'au
  // proprietaire. Le controle a eu lieu avant nous, et il est plus solide
  // qu'une comparaison de chaines.
  //
  // SUR LE RESEAU, il n'y a plus rien de tel : le secret est verifie AVANT de
  // lire le corps, pour qu'un inconnu ne puisse pas nous faire mettre 64 Ko en
  // memoire.
  if (PONT_PAR_RESEAU && !pontSecretValide(req.headers[PONT_ENTETE])) {
    console.warn("[pont] requete interne refusee : secret invalide ou absent");
    pontRepond(res, 401, { erreur: "UNAUTHORIZED" });
    return;
  }

  let corps;
  try {
    corps = JSON.parse(await pontLitLeCorps(req));
  } catch (e) {
    if (e?.message === "CORPS_TROP_GROS") {
      pontRepond(res, 413, { erreur: "BODY_TOO_LARGE" });
    } else {
      pontRepond(res, 400, { erreur: "BAD_JSON" });
    }
    return;
  }

  // Les cles de `meetingRooms` sont les nombres recus des clients WebSocket :
  // une salle passee en chaine par l'API ne trouverait jamais sa Map.
  const salle = Number(corps?.salle);
  if (!Number.isInteger(salle) || salle <= 0) {
    pontRepond(res, 400, { erreur: "BAD_ROOM" });
    return;
  }
  const verbe = typeof corps?.type === "string" ? corps.type : "";
  if (!PONT_VERBE.test(verbe)) {
    pontRepond(res, 400, { erreur: "BAD_TYPE" });
    return;
  }
  const donnees =
    corps?.donnees && typeof corps.donnees === "object" && !Array.isArray(corps.donnees)
      ? corps.donnees
      : {};
  const exclure = typeof corps?.exclure === "string" ? corps.exclure : undefined;

  /*
   * DES PERSONNES NOMMEES, EN PLUS DE LA SALLE (26/08/2026).
   *
   * Le pont ne savait parler qu'a une salle, donc qu'aux sockets qui y sont
   * INSCRITES. Or l'organisateur qui consulte la fiche d'une reunion sans y
   * etre entre n'est dans aucune salle : quand un participant proposait
   * quelqu'un, il ne voyait rien arriver et devait tirer pour rafraichir.
   *
   * Viser des personnes couvre ce cas sans dupliquer le pont, et resservira a
   * tout ce qui concerne quelqu'un en particulier plutot que l'assemblee.
   *
   * ⚠️ ELLES SONT SERVIES MEME SI ELLES SONT DEJA DANS LA SALLE — une seule
   * fois. Sans ce dedoublonnage, l'organisateur present dans la reunion
   * recevrait deux fois le meme avis et relirait deux fois.
   */
  const personnes = Array.isArray(corps?.personnes)
    ? corps.personnes.filter((p) => typeof p === "string" && p !== "")
    : [];

  const message = { ...donnees, type: verbe, meetingId: salle };

  // Une salle vide n'est PAS une erreur : personne n'etait connecte, la
  // modification en base reste valide, et l'API n'a rien a rattraper. Elle rend
  // 0 et le dit dans sa reponse.
  const servies = sendToMeeting(salle, message, exclure);

  let nommees = 0;
  if (personnes.length > 0) {
    const dansLaSalle = meetingRooms.get(salle);
    for (const uid of new Set(personnes)) {
      if (uid === exclure) continue;
      // Deja servi par la diffusion de salle juste au-dessus.
      if (dansLaSalle?.has(uid)) continue;
      if (sendTo(uid, message)) nommees++;
    }
  }

  /*
   * LA SALLE SE FERME AVEC LA REUNION.
   *
   * `meetingRooms` compte les places pour le plafond. Une reunion terminee dont
   * la Map survit tient des sieges pour des gens qui n'y sont plus : la
   * suivante se declarerait pleine sans que personne n'y soit. Le nettoyage est
   * idempotent — `end` peut etre appele deux fois, la seconde ne trouve rien.
   *
   * APRES la diffusion, jamais avant : `sendToMeeting` lit cette meme Map, et
   * la vider d'abord n'annoncerait la fin a personne.
   */
  /*
   * L'EXCLU QUITTE LA SALLE POUR DE BON.
   *
   * Le message `meeting_kicked` fait raccrocher son client — mais un client
   * peut ne pas obeir : onglet fige, reseau coupe au mauvais moment, version
   * ancienne. Sa place resterait alors tenue au plafond, et les autres
   * garderaient sa vignette. On le retire donc AUSSI cote serveur, et on
   * annonce son depart comme pour n'importe quelle sortie.
   *
   * Idempotent : exclure deux fois ne trouve plus rien la seconde.
   */
  if (verbe === "meeting_kicked") {
    const cible = String(donnees?.toUserId ?? "");
    const salleK = meetingRooms.get(salle);
    if (cible && salleK?.has(cible)) {
      salleK.delete(cible);
      if (salleK.size === 0) meetingRooms.delete(salle);
      arretePartageEcran(salle, cible);
      sendToMeeting(salle, { type: "meeting_user_left", meetingId: salle, userId: cible });
    }
  }

  if (verbe === "meeting_ended") {
    const close = meetingRooms.get(salle);
    if (close) {
      close.clear();
      meetingRooms.delete(salle);
    }
    // `arretePartageEcran` vise UNE personne : l'appeler sans identifiant ne
    // supprimait rien et sortait aussitot. La reunion etant close, c'est toute
    // l'entree qui part — et sans annoncer chaque arret, puisqu'il n'y a plus
    // personne dans la salle pour l'entendre.
    partagesEcran.delete(salle);
  }

  pontRepond(res, 200, { ok: true, servies, nommees });
}

const pont = http.createServer((req, res) => {
  pontTraite(req, res).catch((e) => {
    console.error("[pont] requete interne:", e?.message ?? e);
    try {
      pontRepond(res, 500, { erreur: "INTERNAL" });
    } catch {
      // En-tetes deja envoyes : plus rien a dire au client, la trace suffit.
    }
  });
});

// NE TUE PAS LE PROCESS, contrairement au serveur WebSocket juste dessous. Un
// port de pont deja pris ferait perdre les rafraichissements de salle ; sortir
// ferait perdre TOUTE la messagerie temps reel. On crie, et on continue.
pont.on("error", (err) => {
  console.error("[pont] ecouteur interne en erreur:", err?.message ?? err);
});

// DEUX FACONS D'ECOUTER, ET UNE SEULE REGLE QUI COMPTE.
//
// Par defaut : une socket de FICHIER, sans rien a configurer. Ce sont les
// permissions du systeme qui autorisent, et aucun port n'est ouvert.
//
// Sur le RESEAU, quand on a declare un port parce que l'API vit ailleurs : le
// secret devient OBLIGATOIRE. Un port ouvert sans secret laisserait n'importe
// qui diffuser dans n'importe quelle salle — et ce serait d'autant plus grave
// que ce cas-la est justement celui ou la machine n'est plus seule.
//
// C'EST LA FAILLE A NE PAS LAISSER PASSER : poser le port en oubliant le secret
// ne doit pas donner un pont ouvert, mais un pont FERME et un message qui le
// dit. On ne demarre jamais « au mieux » sur une question de securite.
if (PONT_PAR_RESEAU) {
  if (!PONT_SECRET) {
    console.error(
      `[pont] WS_INTERNAL_PORT=${PONT_PORT} est pose mais WS_INTERNAL_SECRET manque : ` +
        "l'ecouteur interne NE DEMARRE PAS. Un pont reseau sans secret serait ouvert a " +
        "quiconque atteint ce port. Posez le secret, ou retirez le port pour revenir a la " +
        "socket de fichier, qui ne demande aucune configuration.",
    );
  } else {
    pont.listen(PONT_PORT, PONT_HOTE, () => {
      console.log(
        `[pont] Ecouteur interne a l'ecoute sur http://${PONT_HOTE}:${PONT_PORT}${PONT_CHEMIN} (reseau, secret exige)`,
      );
    });
  }
} else {
  // Une socket de fichier survit au processus qui l'a creee : apres un arret
  // brutal, le fichier reste et `listen` echouerait sur EADDRINUSE — un pont
  // mort a chaque redemarrage, pour un fichier que plus personne n'ecoute.
  try {
    fs.unlinkSync(PONT_SOCKET);
  } catch {
    // Le fichier n'existait pas : cas normal d'un premier demarrage.
  }

  pont.listen(PONT_SOCKET, () => {
    // 0600 : lisible et inscriptible par le seul proprietaire. C'est CETTE ligne
    // qui remplace le secret partage — un autre utilisateur de la machine ne
    // peut pas ouvrir la socket, la ou il aurait pu deviner ou lire un mot de
    // passe.
    try {
      fs.chmodSync(PONT_SOCKET, 0o600);
    } catch (err) {
      console.error("[pont] permissions de la socket non posees:", err?.message ?? err);
    }
    console.log(`[pont] Ecouteur interne a l'ecoute sur ${PONT_SOCKET} (socket de fichier)`);
  });

  // Retiree a l'arret propre : laisser un fichier mort derriere soi obligerait
  // le demarrage suivant a le nettoyer, et brouillerait le diagnostic de qui
  // regarde le dossier.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try {
        fs.unlinkSync(PONT_SOCKET);
      } catch {
        // Deja parti, ou jamais cree : rien a faire.
      }
      process.exit(0);
    });
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
      else if (msg.type === "ivr_back") await handleIvrBack(ws, msg);
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
      else if (msg.type === "meeting_screen") await handleMeetingScreen(ws, msg);
      else if (msg.type === "meeting_mute") await handleMeetingMute(ws, msg);
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
        // Un onglet ferme au milieu d'une presentation ne previent personne :
        // l'arret du partage part donc d'ici, avant l'annonce du depart, comme
        // dans le depart annonce.
        arretePartageEcran(meetingId, userId);
        room.delete(userId);
        if (room.size === 0) meetingRooms.delete(meetingId);
        // LA PLACE DOIT SE LIBERER EN BASE AUSSI, et pas seulement dans la Map.
        //
        // La socket partait bien de la salle, mais `connecte` restait a 1 : seuls
        // un depart annonce, un refus ou la fin de reunion le remettaient a zero.
        // Or c'est cette colonne que compte la route HTTP d'entree pour appliquer
        // le plafond. Une batterie qui meurt, un tunnel, un onglet tue gardaient
        // donc un siege POUR TOUJOURS — et le suivant se voyait refuser l'entree
        // d'une salle qui avait de la place. Aucun balayage n'y remediait.
        //
        // La duree n'est PAS recalculee ici : une coupure n'est pas un depart
        // voulu, et le participant qui revient dans la minute ne doit pas voir sa
        // participation coupee en deux.
        prisma.meetingParticipant
          .updateMany({
            where: { idMeeting: meetingId, IDparticipant: userId, connecte: 1 },
            data: { connecte: 0 },
          })
          .catch((e) =>
            console.error("[meetings] liberation du siege a la deconnexion:", e?.message ?? e),
          );
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
  // Ferme le pont avant la base : une requete interne en vol ecrirait sinon sur
  // une socket dont le process s'en va.
  pont.close();
  await prisma.$disconnect();
  process.exit(0);
});
