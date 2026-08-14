import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail, handleError } from '@/lib/http';
import { requireUser } from '@/lib/auth-context';
import { creditWallet } from '@/lib/developer/ledger-service';

// POST /api/developer/billing/sandbox — Recharge gratuite / Simulateur Sandbox
export async function POST(req: NextRequest) {
  try {
    const { sub: userId } = requireUser(req);
    const body = await req.json().catch(() => ({}));
    const pack = body.pack?.toString() || 'STARTER';

    let devAccount = await prisma.developerAccount.findUnique({
      where: { userId },
    });

    if (!devAccount) {
      devAccount = await prisma.developerAccount.create({
        data: {
          userId,
          balanceCredits: BigInt(1000),
        },
      });
    }

    let creditsToAdd = BigInt(1000);
    let packName = 'Pack Starter Sandbox (+1 000 Crédits)';

    if (pack === 'PRO') {
      creditsToAdd = BigInt(5750); // 5 000 + 15% bonus offerts
      packName = 'Pack Pro Sandbox (+5 750 Crédits dont +15% offerts)';
    } else if (pack === 'ENTERPRISE') {
      creditsToAdd = BigInt(26000); // 20 000 + 30% bonus offerts
      packName = 'Pack Enterprise Sandbox (+26 000 Crédits dont +30% offerts)';
    }

    const referenceId = `sandbox_ref_${Date.now()}`;
    const updatedDev = await creditWallet(
      devAccount.id,
      creditsToAdd,
      'PURCHASE',
      `Recharge Sandbox gratuite : ${packName}`,
      referenceId
    );

    return ok({
      message: `Recharge Sandbox effectuée avec succès ! ${packName} crédités.`,
      creditsAdded: creditsToAdd.toString(),
      newBalance: updatedDev.balanceCredits.toString(),
    });
  } catch (error) {
    return handleError(error);
  }
}
