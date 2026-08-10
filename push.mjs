// Envoi de notifications push FCM (partagé par ws-server.mjs).
// v1 : désactivé par défaut — aucun import firebase-admin tant que PUSH_ENABLED≠true.

let firebase = null;

function pushExplicitlyDisabled() {
  const flag = process.env.PUSH_ENABLED;
  return flag === "0" || flag === "false";
}

function hasFirebaseCredentials() {
  return Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim());
}

export function isPushEnabled() {
  if (pushExplicitlyDisabled()) return false;
  if (!hasFirebaseCredentials()) return false;
  return true;
}

async function loadFirebase() {
  if (!isPushEnabled()) return null;
  if (firebase === false) return null;
  if (firebase) return firebase;

  try {
    const { initializeApp, cert, getApps } = await import("firebase-admin/app");
    const { getMessaging } = await import("firebase-admin/messaging");

    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    let app = getApps()[0] ?? null;
    if (!app) {
      const sa = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      app = initializeApp({
        credential: cert(sa),
        projectId: process.env.FIREBASE_PROJECT_ID || sa.project_id,
      });
    }
    firebase = { app, getMessaging };
    return firebase;
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND") {
      console.warn(
        "[push] firebase-admin non installé — npm install dans backend/ (ou laisse PUSH_ENABLED=false)",
      );
    } else {
      console.error("[push] init Firebase:", e.message);
    }
    firebase = false;
    return null;
  }
}

async function tokensForUser(prisma, userId) {
  const rows = await prisma.pushDevice.findMany({
    where: { userId },
    select: { token: true },
  });
  return rows.map((r) => r.token);
}

/**
 * Durée de vie d'un push, en millisecondes.
 *
 * ⚠️ SANS TTL, FCM CONSERVE UN MESSAGE JUSQU'À QUATRE SEMAINES. Un téléphone
 * éteint pendant un appel recevait donc « Appel entrant » en se rallumant le
 * lendemain, pour un appel terminé depuis longtemps. Pire : rien ne garantit
 * l'ordre entre deux messages en attente, si bien que l'annulation pouvait être
 * délivrée AVANT l'appel qu'elle annule — la sonnerie repartait alors sans
 * jamais s'arrêter.
 *
 * 90 s pour l'appel : la valeur au-delà de laquelle le serveur le déclare sans
 * réponse. 120 s pour l'annulation, volontairement plus long — elle doit
 * toujours survivre à l'appel qu'elle vient éteindre.
 */
export const TTL_APPEL_MS = 90 * 1000;
export const TTL_ANNULATION_MS = 120 * 1000;

export async function sendPushToUser(prisma, userId, { title, body, data = {}, dataOnly = false, ttlMs = null }) {
  const fb = await loadFirebase();
  if (!fb) return;

  const tokens = await tokensForUser(prisma, userId);
  if (tokens.length === 0) return;

  try {
    const messaging = fb.getMessaging(fb.app);
    // dataOnly : pas de bloc "notification" → le handler d'arrière-plan du
    // client contrôle l'affichage (nécessaire pour la notif d'appel plein écran).
    const payload = {
      tokens,
      data,
      // `ttl` en millisecondes côté Android (firebase-admin), en SECONDES pour
      // l'en-tête webpush, et en horodatage d'expiration absolu pour APNs :
      // trois unités différentes pour la même intention.
      android: {
        priority: "high",
        ...(ttlMs != null ? { ttl: ttlMs } : {}),
      },
      apns: {
        payload: { aps: { sound: "default" } },
        ...(ttlMs != null
          ? {
              headers: {
                "apns-expiration": String(
                  Math.floor(Date.now() / 1000) + Math.floor(ttlMs / 1000),
                ),
              },
            }
          : {}),
      },
      webpush: {
        headers: {
          Urgency: "high",
          ...(ttlMs != null ? { TTL: String(Math.floor(ttlMs / 1000)) } : {}),
        },
      },
    };
    if (!dataOnly) payload.notification = { title, body };
    const res = await messaging.sendEachForMulticast(payload);

    const stale = [];
    res.responses.forEach((r, i) => {
      if (
        !r.success &&
        r.error?.code &&
        ["messaging/invalid-registration-token", "messaging/registration-token-not-registered"].includes(
          r.error.code,
        )
      ) {
        stale.push(tokens[i]);
      }
    });
    if (stale.length > 0) {
      await prisma.pushDevice.deleteMany({ where: { token: { in: stale } } });
    }
  } catch (e) {
    console.error("[push] envoi FCM:", e.message);
  }
}

export async function pushNewMessage(prisma, {
  recipientId,
  senderName,
  convId,
  convTitle,
  preview,
  messageType,
}) {
  if (!isPushEnabled()) return;

  const title = convTitle || senderName || "Nouveau message";
  const body =
    messageType === "IMAGE"
      ? `${senderName} : 🖼️ Image`
      : messageType === "AUDIO"
        ? `${senderName} : 🎤 Message vocal`
        : messageType === "FILE"
          ? `${senderName} : 📎 Fichier`
          : preview || "Nouveau message";

  await sendPushToUser(prisma, recipientId, {
    title,
    body,
    data: {
      type: "message",
      convId: convId ?? "",
      title: convTitle || senderName || "",
    },
  });
}

export async function pushIncomingCall(prisma, {
  recipientId,
  callId,
  convId,
  callerName,
  callType,
  isGroup,
  groupName,
}) {
  if (!isPushEnabled()) return;

  const title = isGroup ? `Appel de groupe · ${groupName || "Groupe"}` : "Appel entrant";
  const body = isGroup
    ? `${callerName} appelle le groupe`
    : `${callerName} · ${callType === "VIDEO" ? "Vidéo" : "Audio"}`;

  await sendPushToUser(prisma, recipientId, {
    title,
    body,
    // data-only → déclenche le handler d'arrière-plan qui affiche la notif
    // d'appel PLEIN ÉCRAN (full-screen intent) même app fermée.
    dataOnly: true,
    ttlMs: TTL_APPEL_MS,
    data: {
      type: "incoming_call",
      callId,
      convId: convId ?? "",
      callerName,
      callType,
      isGroup: String(Boolean(isGroup)),
      title,
      body,
      // Horodatage d'ÉMISSION. Le TTL empêche FCM de garder le message trop
      // longtemps, mais un push déjà en transit peut malgré tout arriver en
      // retard : le client compare cette date à l'heure de réception et ignore
      // un appel périmé, plutôt que de faire sonner dans le vide.
      sentAt: new Date().toISOString(),
    },
  });
}

/**
 * Notifie quelqu'un qu'il vient d'être ajouté à une réunion.
 *
 * ⚠️ AUCUNE DATE N'EST ÉCRITE DANS LE TEXTE, et c'est délibéré. Le serveur
 * tourne en UTC, ses utilisateurs non : formater ici « à 14 h 30 » afficherait
 * une heure fausse d'un décalage horaire, et une notification ne peut pas être
 * corrigée après coup. La date exacte est lisible dans l'application, qui la
 * rend dans le fuseau du téléphone ; on ne dit ici que ce qui reste vrai
 * partout — le sujet, l'organisateur, et le fait qu'elle ait déjà commencé.
 */
export async function pushMeetingInvitation(prisma, {
  recipientId,
  meetingId,
  objet,
  organiserName,
  enCours = false,
}) {
  if (!isPushEnabled()) return;
  const sujet = objet?.trim() || "Réunion";
  await sendPushToUser(prisma, recipientId, {
    title: enCours ? "Réunion en cours" : "Invitation à une réunion",
    body: enCours
      ? `${organiserName} vous a ajouté à « ${sujet} », déjà commencée`
      : `${organiserName} vous a ajouté à « ${sujet} »`,
    data: {
      type: "meeting_invitation",
      meetingId: String(meetingId),
      objet: sujet,
      organiserName: organiserName ?? "",
      enCours: String(Boolean(enCours)),
    },
  });
}

/** Notifie (data-only) que l'appel est terminé/annulé → le client retire la
 *  notif d'appel plein écran, même app fermée. Ciblé par le callId partagé. */
export async function pushCallCancelled(prisma, { recipientId, callId }) {
  if (!isPushEnabled()) return;
  await sendPushToUser(prisma, recipientId, {
    title: "",
    body: "",
    dataOnly: true,
    // Plus long que l'appel : une annulation doit toujours survivre à ce
    // qu'elle éteint, sinon la notification d'appel reste affichée.
    ttlMs: TTL_ANNULATION_MS,
    data: { type: "call_cancelled", callId: callId ?? "" },
  });
}
