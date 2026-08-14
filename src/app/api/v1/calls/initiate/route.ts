import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { validateApiKey } from '@/lib/developer/key-service';
import { reserveCallHold, DEFAULT_CALL_HOLD_CREDITS } from '@/lib/developer/ledger-service';

// POST /api/v1/calls/initiate — API Développeur v1 : Initiation d'appel WebRTC (HOLD 50 crédits)
export async function POST(req: NextRequest) {
  try {
    // 1. Validation de la clé API
    const authHeader = req.headers.get('Authorization') || '';
    const customHeader = req.headers.get('X-Api-Key') || '';
    const rawKey = authHeader.replace(/^Bearer\s+/i, '') || customHeader;

    if (!rawKey) {
      return fail('Clé API manquante. En-tête X-Api-Key ou Authorization: Bearer ak_... requis.', 401);
    }

    const keyData = await validateApiKey(rawKey);
    if (!keyData || !keyData.developer) {
      return fail('Clé API invalide, révoquée ou introuvable.', 401);
    }

    const developer = keyData.developer;

    // 2. Traitement du corps de requête
    const body = await req.json().catch(() => ({}));
    const recipientNumber = body.recipientNumber?.toString().trim();
    const isVideo = Boolean(body.isVideo);

    if (!recipientNumber) {
      return fail('Le champ recipientNumber est requis.', 400);
    }

    // 3. Identification du destinataire
    const recipient = await prisma.user.findFirst({
      where: {
        OR: [{ publicNumber: recipientNumber }, { mobile: recipientNumber }],
      },
      select: { id: true, publicNumber: true, isOnline: true },
    });

    if (!recipient) {
      return fail(`Destinataire Alanya introuvable avec le numéro ${recipientNumber}.`, 404);
    }

    const callId = `call_api_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // 4. Pose d'une réservation temporaire (HOLD) de 5 minutes (50 crédits)
    const holdResult = await reserveCallHold(developer.id, callId, DEFAULT_CALL_HOLD_CREDITS);

    if (!holdResult.success) {
      return fail(
        holdResult.error || 'Solde insuffisant pour réserver un appel (50 crédits requis pour 5 min).',
        429
      );
    }

    return ok({
      success: true,
      callId,
      recipientNumber: recipient.publicNumber,
      recipientOnline: recipient.isOnline === 1,
      type: isVideo ? 'VIDEO' : 'AUDIO',
      holdReservedCredits: DEFAULT_CALL_HOLD_CREDITS.toString(),
      message: 'Appel WebRTC initié avec succès. Réservation de 5 minutes activée.',
    });
  } catch (error: any) {
    console.error('[API v1 Calls] Erreur d\'initiation d\'appel:', error);
    return fail('Erreur interne lors de l\'initiation d\'appel API.', 500);
  }
}
