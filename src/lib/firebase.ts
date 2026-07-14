// Firebase Admin — réservé v2 (non utilisé en v1).
// Réactiver avec npm install firebase-admin + MAIL_PROVIDER=firebase.

export function isFirebaseConfigured(): boolean {
  return false;
}

export function getFirebaseApp(): null {
  return null;
}

export async function queueFirebaseEmail(_opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  throw new Error("Firebase email désactivé en v1 — utilise MAIL_PROVIDER=smtp (Gmail)");
}
