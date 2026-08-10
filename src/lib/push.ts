import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { pushMeetingInvitation } from "../../push.mjs";

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

/**
 * Notifie quelqu'un qu'il vient d'être ajouté à une réunion.
 *
 * Délègue à `push.mjs`, la SEULE implémentation d'envoi FCM du projet, celle
 * qu'utilise déjà `ws-server.mjs`. Même raison qu'à `calls.ts` → `call-labels
 * .mjs` : le serveur WebSocket est un process Node séparé, hors compilation
 * Next, et ne peut pas importer de TypeScript. Une seconde implémentation ici
 * finirait par diverger de celle qui envoie les appels et les messages.
 *
 * ⚠️ Cette fonction remplace un `sendPushToUser` qui ne faisait RIEN : un
 * vestige de la v1, resté exporté avec un corps vide. Aucune route ne s'en
 * servait, mais sa seule présence donnait à croire que les routes HTTP
 * pouvaient notifier — elles ne le pouvaient pas.
 */
export async function notifieInvitationReunion(args: {
  recipientId: string;
  meetingId: number;
  objet: string;
  organiserName: string;
  enCours?: boolean;
}): Promise<void> {
  await pushMeetingInvitation(prisma, args);
}
