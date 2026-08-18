import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { validateApiKey } from '@/lib/developer/key-service';
import { debitMessageQuota, COST_PER_MESSAGE } from '@/lib/developer/ledger-service';
import { CODE, STATUT_SOLDE_INSUFFISANT } from '@/lib/developer/api-contract';

// POST /api/v1/auth/otp/send — Génération et envoi de code OTP (1 Crédit ALC)
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

    if (!recipientNumber) {
      return fail('Le champ recipientNumber est requis.', 400, CODE.REQUETE_INVALIDE);
    }

    // Génération d'un code à 6 chiffres
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // Expiration dans 5 minutes

    // Enregistrement de l'OTP en BDD
    await prisma.developerOtp.create({
      data: {
        developerId: developer.id,
        recipientNumber,
        code: otpCode,
        expiresAt,
      },
    });

    // Envoi du message Alanya contenant le code OTP
    const otpContent = `Votre code de vérification Alanya est : ${otpCode}. Ce code expire dans 5 minutes.`;
    const recipient = await prisma.user.findFirst({
      where: { OR: [{ publicNumber: recipientNumber }, { mobile: recipientNumber }] },
      select: { id: true, publicNumber: true },
    });

    if (recipient) {
      const debitRes = await debitMessageQuota(developer.id, `otp_${Date.now()}`, COST_PER_MESSAGE);
      if (!debitRes.success) {
        // 402 et non 429 — voir `api-contract.ts` : recharger, pas réessayer.
        return fail(
          'Solde de crédits insuffisant.',
          STATUT_SOLDE_INSUFFISANT,
          CODE.SOLDE_INSUFFISANT,
        );
      }

      let conv = await prisma.conversation.findFirst({
        where: { isGroup: false, participants: { every: { userId: { in: [developer.userId, recipient.id] } } } },
      });

      if (!conv) {
        conv = await prisma.conversation.create({
          data: { isGroup: false, participants: { create: [{ userId: developer.userId }, { userId: recipient.id }] } },
        });
      }

      await prisma.message.create({
        data: { convId: conv.id, senderId: developer.userId, content: otpContent, type: 'TEXT', status: 'SENT' },
      });
    }

    return ok({
      success: true,
      recipientNumber,
      message: 'Code OTP généré et envoyé avec succès. Valide 5 minutes.',
      expiresInSeconds: 300,
    });
  } catch (error: any) {
    console.error('[API OTP Send] Erreur:', error);
    return fail('Erreur lors de la génération de l\'OTP', 500, CODE.ERREUR_INTERNE);
  }
}
