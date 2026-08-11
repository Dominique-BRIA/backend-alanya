import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import {
  pushMeetingInvitation,
  pushMeetingRequest,
  pushMeetingRequestDecided,
} from "../../push.mjs";

export function isPushConfigured(): boolean {
  return env.push.enabled();
}

export async function registerPushToken(
  userId: string,
  token: string,
  platform: string,
  deviceId?: string,
): Promise<void> {
  await prisma.pushDevice.upsert({
    where: { token },
    // `deviceId` est ce qui permet de couper les notifications d'UN appareil —
    // à sa déconnexion, ou quand une connexion ailleurs l'évince. Sans lui,
    // l'envoi ne sait cibler qu'un compte.
    create: { userId, token, platform, deviceId: deviceId ?? null },
    update: {
      userId,
      platform,
      // On n'écrase pas un identifiant connu par un envoi qui n'en porte pas :
      // un client plus ancien ne doit pas effacer ce qu'un client à jour a
      // renseigné pour le même jeton.
      ...(deviceId ? { deviceId } : {}),
      updatedAt: new Date(),
    },
  });
}

/**
 * Coupe les notifications d'appareils entiers.
 *
 * ⚠️ Les lignes SANS `deviceId` de la même famille partent aussi. Ce sont les
 * enregistrements antérieurs à cette colonne : on ne peut les rattacher à aucun
 * appareil, et les laisser en place ferait exactement ce qu'on cherche à
 * empêcher — un téléphone parti qui continue de sonner. Le client encore en
 * place réenregistre son jeton au démarrage suivant, avec son identifiant.
 */
export async function supprimeJetonsPushDAppareils(
  userId: string,
  deviceIds: string[],
  plateformes: string[],
): Promise<number> {
  const { count } = await prisma.pushDevice.deleteMany({
    where: {
      userId,
      OR: [
        ...(deviceIds.length > 0 ? [{ deviceId: { in: deviceIds } }] : []),
        { deviceId: null, platform: { in: plateformes } },
      ],
    },
  });
  return count;
}

/** Coupe les notifications d'UN appareil — sa déconnexion volontaire. */
export async function supprimeJetonsPushDUnAppareil(
  userId: string,
  deviceId: string,
): Promise<number> {
  const { count } = await prisma.pushDevice.deleteMany({
    where: { userId, deviceId },
  });
  return count;
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

/** Prévient l'organisateur qu'on lui demande de faire entrer quelqu'un. */
export async function notifieDemandeReunion(args: {
  recipientId: string;
  meetingId: number;
  objet: string;
  demandeurName: string;
  inviteName: string;
}): Promise<void> {
  await pushMeetingRequest(prisma, args);
}

/**
 * Annonce la décision au DEMANDEUR — et à lui seul.
 *
 * La personne proposée n'apprend jamais qu'un refus a eu lieu, ni même qu'une
 * demande a existé.
 */
export async function notifieDecisionDemandeReunion(args: {
  recipientId: string;
  meetingId: number;
  objet: string;
  inviteName: string;
  accepte: boolean;
}): Promise<void> {
  await pushMeetingRequestDecided(prisma, args);
}
