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

export async function sendPushToUser(prisma, userId, { title, body, data = {} }) {
  const fb = await loadFirebase();
  if (!fb) return;

  const tokens = await tokensForUser(prisma, userId);
  if (tokens.length === 0) return;

  try {
    const messaging = fb.getMessaging(fb.app);
    const res = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      data,
      android: { priority: "high" },
      apns: { payload: { aps: { sound: "default" } } },
      webpush: { headers: { Urgency: "high" } },
    });

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
    data: {
      type: "incoming_call",
      callId,
      convId: convId ?? "",
      callerName,
      callType,
      isGroup: String(Boolean(isGroup)),
    },
  });
}
