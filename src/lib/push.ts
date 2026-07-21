import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";

export function isPushConfigured(): boolean {
  return env.push.enabled();
}

export async function registerPushToken(
  userId: string,
  token: string,
  platform: string,
): Promise<void> {
  await prisma.pushDevice.upsert({
    where: { token },
    create: { userId, token, platform },
    update: { userId, platform, updatedAt: new Date() },
  });
}

export async function unregisterPushToken(userId: string, token: string): Promise<void> {
  await prisma.pushDevice.deleteMany({ where: { userId, token } });
}

/** Envoie une notification FCM (v2 — implémenté dans push.mjs côté WebSocket). */
export async function sendPushToUser(
  _userId: string,
  _payload: {
    title: string;
    body: string;
    data?: Record<string, string>;
  },
): Promise<void> {
  // v1 : push désactivé ; voir backend/push.mjs pour la v2.
  if (!env.push.enabled()) return;
}
