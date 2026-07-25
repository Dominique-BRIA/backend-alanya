import { prisma } from "./prisma";

// Blocage — SOURCE DE VÉRITÉ : la table `Blocked` (owner → utilisateur bloqué).
// `Contact.isBlocked` est conservé comme MIROIR local (utilisé par le filtre du
// fil de statuts et la fiche contact) et tenu synchronisé par les helpers
// ci-dessous. Ainsi la fiche contact et l'écran Réglages > Bloqués restent
// cohérents, et le blocage est réellement appliqué (voir ws-server).

/// Deux personnes sont « bloquées » si l'une a bloqué l'autre (peu importe le
/// sens) → plus aucune interaction message/appel entre elles.
export async function areBlocked(userA: string, userB: string): Promise<boolean> {
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

/// Crée ou supprime la ligne `Blocked` (owner bloque target). Idempotent.
export async function setBlockRow(
  ownerId: string,
  targetUserId: string,
  blocked: boolean,
): Promise<void> {
  if (ownerId === targetUserId) return;
  if (blocked) {
    await prisma.blocked.upsert({
      where: {
        alanyaID_idCallerBlock: { alanyaID: ownerId, idCallerBlock: targetUserId },
      },
      create: { alanyaID: ownerId, idCallerBlock: targetUserId },
      update: {},
    });
  } else {
    await prisma.blocked.deleteMany({
      where: { alanyaID: ownerId, idCallerBlock: targetUserId },
    });
  }
}

/// Reflète l'état de blocage sur le flag local `Contact.isBlocked` (si ce
/// contact existe dans le répertoire de owner). Sans effet sinon.
export async function mirrorContactBlock(
  ownerId: string,
  targetUserId: string,
  blocked: boolean,
): Promise<void> {
  await prisma.contact.updateMany({
    where: { userId: ownerId, contactId: targetUserId },
    data: { isBlocked: blocked },
  });
}
