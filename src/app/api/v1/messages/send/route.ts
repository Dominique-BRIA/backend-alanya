import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { validateApiKey } from '@/lib/developer/key-service';
import { debitMessageQuota, COST_PER_MESSAGE } from '@/lib/developer/ledger-service';

// POST /api/v1/messages/send — API Développeur v1 : Envoi de message texte (1 Crédit)
export async function POST(req: NextRequest) {
  try {
    // 1. Extraction et validation de la clé API
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
    const content = body.content?.toString().trim();

    if (!recipientNumber || !content) {
      return fail('Les champs recipientNumber et content sont requis.', 400);
    }

    // 3. Identification du destinataire Alanya
    const recipient = await prisma.user.findFirst({
      where: {
        OR: [{ publicNumber: recipientNumber }, { mobile: recipientNumber }],
      },
      select: { id: true, publicNumber: true, email: true },
    });

    if (!recipient) {
      return fail(`Destinataire Alanya introuvable avec le numéro ${recipientNumber}.`, 404);
    }

    const messageId = `msg_api_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // 4. Débit atomique du crédit
    const debitResult = await debitMessageQuota(developer.id, messageId, COST_PER_MESSAGE);

    if (!debitResult.success) {
      return fail(
        debitResult.error || 'Solde de crédits insuffisant. Veuillez recharger votre compte.',
        429
      );
    }

    // 5. Recherche ou création d'une conversation directe entre l'expéditeur et le destinataire
    const senderUserId = developer.userId;
    let conversation = await prisma.conversation.findFirst({
      where: {
        isGroup: false,
        participants: { every: { userId: { in: [senderUserId, recipient.id] } } },
      },
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          isGroup: false,
          participants: {
            create: [{ userId: senderUserId }, { userId: recipient.id }],
          },
        },
      });
    }

    // 6. Enregistrement du message en base
    const savedMessage = await prisma.message.create({
      data: {
        convId: conversation.id,
        senderId: senderUserId,
        content: `[API Dev] ${content}`,
        type: 'TEXT',
      },
    });

    return ok({
      success: true,
      messageId: savedMessage.id,
      recipient: recipient.publicNumber,
      creditsConsumed: COST_PER_MESSAGE.toString(),
      balanceRemaining: debitResult.balanceRemaining?.toString(),
    });
  } catch (error: any) {
    console.error('[API v1 Messages] Erreur d\'envoi:', error);
    return fail('Erreur interne du serveur lors de l\'envoi du message API.', 500);
  }
}
