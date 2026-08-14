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

    // 3. Identification du destinataire Alanya (par publicNumber ou numéro mobile)
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
        content: content,
        type: 'TEXT',
        status: 'SENT',
      },
    });

    // 7. Mise à jour du dernier message de la conversation pour l'affichage dans la liste des chats
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessage: content.slice(0, 500) || null,
        lastMessageAt: new Date(),
        lastMessageSenderID: senderUserId,
        lastMessageType: 0,
        lastMessageStatus: 0,
      },
    });

    // 8. Incrémentation du nombre de messages non lus pour le destinataire
    await prisma.participant.updateMany({
      where: { convId: conversation.id, userId: { not: senderUserId } },
      data: { unreadCount: { increment: 1 } },
    });

    // 9. Envoi de notification push (si configuré)
    try {
      const { sendPushToUser } = await import('@/../push.mjs');
      await sendPushToUser(prisma, recipient.id, {
        title: 'Nouveau message Alanya',
        body: content,
        data: { convId: conversation.id, messageId: savedMessage.id, type: 'chat_message' },
      });
    } catch {
      // Ignorer silencieusement si Push n'est pas configuré
    }

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
