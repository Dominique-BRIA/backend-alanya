import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { validateApiKey } from '@/lib/developer/key-service';
import { CODE } from '@/lib/developer/api-contract';

// POST /api/v1/auth/otp/verify — Vérification du code OTP (2FA)
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const customHeader = req.headers.get('X-Api-Key') || '';
    const rawKey = authHeader.replace(/^Bearer\s+/i, '') || customHeader;

    if (!rawKey) {
      return fail('Clé API manquante.', 401, CODE.CLE_MANQUANTE);
    }

    const keyData = await validateApiKey(rawKey);
    if (!keyData || !keyData.developer) {
      return fail('Clé API invalide ou révoquée.', 401, CODE.CLE_INVALIDE);
    }

    const developer = keyData.developer;
    const body = await req.json().catch(() => ({}));
    const recipientNumber = body.recipientNumber?.toString().trim();
    const code = body.code?.toString().trim();

    if (!recipientNumber || !code) {
      return fail('Les champs recipientNumber et code sont requis.', 400, CODE.REQUETE_INVALIDE);
    }

    // Recherche de l'OTP valide non encore vérifié et non expiré
    const otpRecord = await prisma.developerOtp.findFirst({
      where: {
        developerId: developer.id,
        recipientNumber,
        code,
        isVerified: false,
        expiresAt: { gte: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpRecord) {
      return fail('Code OTP invalide, expiré ou déjà utilisé.', 400, CODE.REQUETE_INVALIDE);
    }

    // Marquer l'OTP comme vérifié
    await prisma.developerOtp.update({
      where: { id: otpRecord.id },
      data: { isVerified: true },
    });

    return ok({
      verified: true,
      recipientNumber,
      message: 'Code OTP vérifié avec succès.',
    });
  } catch (error: any) {
    console.error('[API OTP Verify] Erreur:', error);
    return fail('Erreur de vérification de l\'OTP', 500, CODE.ERREUR_INTERNE);
  }
}
