import { prisma } from '@/lib/prisma';
import { TransactionType, TransactionStatus } from '@prisma/client';

export const COST_PER_MESSAGE = BigInt(1); // 1 crédit par message texte
export const COST_PER_CALL_MINUTE = BigInt(10); // 10 crédits par minute d'appel audio/vidéo
export const DEFAULT_CALL_HOLD_CREDITS = BigInt(50); // Réservation initiale 5 minutes (50 crédits)

/**
 * Récupère le solde du compte développeur avec calcul de sécurité.
 */
export async function getDeveloperWallet(developerId: string) {
  return await prisma.developerAccount.findUnique({
    where: { id: developerId },
    select: {
      id: true,
      userId: true,
      companyName: true,
      balanceCredits: true,
      holdCredits: true,
      createdAt: true,
    },
  });
}

/**
 * Recharche / Crédite le solde du compte développeur (Achat / Bonus / Sandbox).
 */
export async function creditWallet(
  developerId: string,
  creditsToAdd: bigint,
  type: TransactionType = TransactionType.PURCHASE,
  description: string = 'Rechargement de crédits',
  referenceId?: string
) {
  return await prisma.$transaction(async (tx) => {
    // 1. Mise à jour du solde
    const dev = await tx.developerAccount.update({
      where: { id: developerId },
      data: {
        balanceCredits: { increment: creditsToAdd },
      },
    });

    // 2. Inscription au registre immuable (Ledger)
    await tx.devLedger.create({
      data: {
        developerId,
        amount: creditsToAdd,
        type,
        status: TransactionStatus.SETTLED,
        description,
        referenceId,
      },
    });

    return dev;
  });
}

/**
 * Débit atomique du solde pour l'envoi d'un message API.
 * Garantit zéro solde négatif grâce au verrouillage PostgreSQL.
 */
export async function debitMessageQuota(
  developerId: string,
  messageId: string,
  costCredits: bigint = COST_PER_MESSAGE
): Promise<{ success: boolean; balanceRemaining?: bigint; error?: string }> {
  try {
    // Débit atomique SQL avec contrainte balance_credits >= costCredits
    const affected = await prisma.$executeRaw`
      UPDATE "developer_accounts"
      SET "balance_credits" = "balance_credits" - ${costCredits}
      WHERE "developer_id" = ${developerId}::uuid 
        AND ("balance_credits" - "hold_credits") >= ${costCredits}
    `;

    if (affected === 0) {
      return {
        success: false,
        error: 'Solde de crédits insuffisant pour envoyer le message.',
      };
    }

    // Inscription dans le ledger
    await prisma.devLedger.create({
      data: {
        developerId,
        amount: -costCredits,
        type: TransactionType.MESSAGE_SENT,
        status: TransactionStatus.SETTLED,
        description: `Envoi de message API (${costCredits} crédit)`,
        referenceId: messageId,
      },
    });

    const updated = await prisma.developerAccount.findUnique({
      where: { id: developerId },
      select: { balanceCredits: true },
    });

    return {
      success: true,
      balanceRemaining: updated?.balanceCredits,
    };
  } catch (error) {
    console.error('[LedgerService] Erreur lors du débit message:', error);
    return { success: false, error: 'Erreur interne de traitement de quota.' };
  }
}

/**
 * Pose une réservation temporaire (HOLD) lors du démarrage d'un appel WebRTC.
 */
export async function reserveCallHold(
  developerId: string,
  callId: string,
  holdAmount: bigint = DEFAULT_CALL_HOLD_CREDITS
): Promise<{ success: boolean; error?: string }> {
  try {
    const affected = await prisma.$executeRaw`
      UPDATE "developer_accounts"
      SET "hold_credits" = "hold_credits" + ${holdAmount}
      WHERE "developer_id" = ${developerId}::uuid 
        AND ("balance_credits" - "hold_credits") >= ${holdAmount}
    `;

    if (affected === 0) {
      return {
        success: false,
        error: 'Crédits insuffisants pour initier l\'appel (réservation de 5 min requise).',
      };
    }

    await prisma.devLedger.create({
      data: {
        developerId,
        amount: -holdAmount,
        type: TransactionType.HOLD_RESERVE,
        status: TransactionStatus.PENDING,
        description: `Réservation d'appel WebRTC (${holdAmount} crédits)`,
        referenceId: callId,
      },
    });

    return { success: true };
  } catch (error) {
    console.error('[LedgerService] Erreur lors du HOLD d\'appel:', error);
    return { success: false, error: 'Erreur de réservation WebRTC.' };
  }
}

/**
 * Règle la consommation réelle (SETTLE) à la fin ou minute par minute pendant l'appel.
 */
export async function settleCallMinutes(
  developerId: string,
  callId: string,
  actualMinutes: number,
  costPerMinute: bigint = COST_PER_CALL_MINUTE
): Promise<{ success: boolean; totalCost: bigint }> {
  const actualCost = BigInt(Math.max(1, actualMinutes)) * COST_PER_CALL_MINUTE;

  await prisma.$transaction(async (tx) => {
    // 1. Libère la réservation HOLD et débite le solde réel
    await tx.developerAccount.update({
      where: { id: developerId },
      data: {
        holdCredits: { decrement: DEFAULT_CALL_HOLD_CREDITS },
        balanceCredits: { decrement: actualCost },
      },
    });

    // 2. Marque le HOLD comme annulé/terminé
    await tx.devLedger.updateMany({
      where: { developerId, referenceId: callId, status: TransactionStatus.PENDING },
      data: { status: TransactionStatus.CANCELLED },
    });

    // 3. Inscrit le débit réglé final
    await tx.devLedger.create({
      data: {
        developerId,
        amount: -actualCost,
        type: TransactionType.CALL_MINUTE,
        status: TransactionStatus.SETTLED,
        description: `Appel WebRTC effectué (${actualMinutes} min, ${actualCost} crédits)`,
        referenceId: callId,
      },
    });
  });

  return { success: true, totalCost: actualCost };
}
