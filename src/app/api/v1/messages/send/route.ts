import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { validateApiKey } from '@/lib/developer/key-service';
import { debitMessageQuota, COST_PER_MESSAGE } from '@/lib/developer/ledger-service';

// POST /api/v1/messages/send — Conforme WhatsApp Cloud API & Alanya Dev API (1 Crédit)
export async function POST(req: NextRequest) {
  const startTime = Date.now();
  let keyPrefix: string | null = null;
  let devId: string | null = null;

  try {
    // 1. Validation de la Clé API
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
    devId = developer.id;
    keyPrefix = rawKey.slice(0, 12);

    // 2. Traitement du corps de requête (Support double format : WhatsApp Standard et Alanya Standard)
    const body = await req.json().catch(() => ({}));
    const recipientNumber = (body.to || body.recipientNumber || body.phone)?.toString().trim();
    const type = body.type || 'text';

    let content = '';
    let mediaUrl: string | null = null;
    let messageType: 'TEXT' | 'IMAGE' | 'AUDIO' | 'FILE' = 'TEXT';

    if (type === 'text') {
      content = (body.text?.body || body.content || body.text)?.toString().trim();
    } else if (type === 'image') {
      mediaUrl = body.image?.link || body.image?.url || body.image?.id || body.link || body.url || null;
      content = body.image?.caption || body.content || '';
      messageType = 'IMAGE';
    } else if (type === 'audio') {
      mediaUrl = body.audio?.link || body.audio?.url || body.audio?.id || body.link || body.url || null;
      content = body.audio?.caption || body.content || '';
      messageType = 'AUDIO';
    } else if (type === 'document' || type === 'file') {
      mediaUrl = body.document?.link || body.document?.url || body.document?.id || body.link || body.url || null;
      content = body.document?.caption || body.content || body.filename || '';
      messageType = 'FILE';
    } else if (type === 'location') {
      const loc = body.location || {};
      content = `📍 Localisation : ${loc.name || 'Position'} (${loc.latitude}, ${loc.longitude})`;
    } else if (type === 'interactive') {
      const inter = body.interactive || {};
      content = `${inter.body?.text || inter.text || 'Message interactif'}\n` +
        (inter.action?.buttons || []).map((b: any) => `[${b.reply?.title || b.title}]`).join(' ');
    } else if (type === 'template') {
      content = `[Modèle ${body.template?.name || 'Alanya'}] : ${body.content || 'Code de confirmation'}`;
    } else {
      content = (body.content || body.text?.body || '').toString().trim();
    }

    // Résolution d'un éventuel media_id si transmis au format WhatsApp
    if (mediaUrl && (mediaUrl.startsWith('med_') || mediaUrl.length === 36)) {
      const devMedia = await prisma.developerMedia.findFirst({
        where: { OR: [{ id: mediaUrl }, { url: mediaUrl }] },
      });
      if (devMedia) {
        mediaUrl = devMedia.url;
      }
    }

    if (!recipientNumber || (!content && !mediaUrl)) {
      const res = fail('Le destinataire (to / recipientNumber) et un contenu/média sont requis.', 400);
      void logTelemetry(devId, keyPrefix, '/api/v1/messages/send', 'POST', 400, Date.now() - startTime);
      return res;
    }

    // 3. Identification du destinataire Alanya
    const recipient = await prisma.user.findFirst({
      where: { OR: [{ publicNumber: recipientNumber }, { mobile: recipientNumber }] },
      select: { id: true, publicNumber: true, email: true },
    });

    if (!recipient) {
      const res = fail(`Destinataire Alanya introuvable avec le numéro ${recipientNumber}.`, 404);
      void logTelemetry(devId, keyPrefix, '/api/v1/messages/send', 'POST', 404, Date.now() - startTime);
      return res;
    }

    const messageId = `wamid.${Date.now()}.${Math.random().toString(36).slice(2, 9)}`;

    // 4. Débit du crédit ALC
    const debitResult = await debitMessageQuota(developer.id, messageId, COST_PER_MESSAGE);
    if (!debitResult.success) {
      const res = fail(debitResult.error || 'Solde de crédits insuffisant. Veuillez recharger votre compte.', 429);
      void logTelemetry(devId, keyPrefix, '/api/v1/messages/send', 'POST', 429, Date.now() - startTime);
      return res;
    }

    // 5. Recherche ou création de la conversation
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
          participants: { create: [{ userId: senderUserId }, { userId: recipient.id }] },
        },
      });
    }

    // 6. Sauvegarde du message en base
    const savedMessage = await prisma.message.create({
      data: {
        convId: conversation.id,
        senderId: senderUserId,
        content: content || null,
        type: messageType,
        status: 'SENT',
      },
    });

    // 6.b Création de la pièce jointe média (MediaFile)
    if (mediaUrl) {
      const filename = mediaUrl.split('/').pop()?.split('?')[0] || (messageType === 'IMAGE' ? 'image.png' : messageType === 'AUDIO' ? 'audio.mp3' : 'document.pdf');
      const mimeType = messageType === 'IMAGE' ? 'image/png' : messageType === 'AUDIO' ? 'audio/mpeg' : 'application/pdf';

      await prisma.mediaFile.create({
        data: {
          ownerId: senderUserId,
          messageId: savedMessage.id,
          filename: filename,
          mimeType: mimeType,
          sizeBytes: 1024,
          url: mediaUrl,
        },
      });
    }

    // 7. Mise à jour de la conversation
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessage: content.slice(0, 500) || null,
        lastMessageAt: new Date(),
        lastMessageSenderID: senderUserId,
      },
    });

    // 8. Incrémentation du compteur de messages non lus
    await prisma.participant.updateMany({
      where: { convId: conversation.id, userId: { not: senderUserId } },
      data: { unreadCount: { increment: 1 } },
    });

    // 9. Envoi push notification
    try {
      const { sendPushToUser } = await import('@/../push.mjs');
      await sendPushToUser(prisma, recipient.id, {
        title: 'Nouveau message Alanya',
        body: content,
        data: { convId: conversation.id, messageId: savedMessage.id, type: 'chat_message' },
      });
    } catch {
      // Ignorer si Push non configuré
    }

    // 10. Notification Webhook Développeur (Callback de statut WhatsApp `delivered`)
    void dispatchDeveloperWebhook(developer.id, messageId, 'delivered', recipient.publicNumber);

    // 11. Télémétrie & Réponse au format WhatsApp Cloud API
    void logTelemetry(devId, keyPrefix, '/api/v1/messages/send', 'POST', 200, Date.now() - startTime);

    return ok({
      messaging_product: 'alanya',
      contacts: [{ input: recipientNumber, wa_id: recipient.publicNumber }],
      messages: [{ id: messageId, message_status: 'accepted' }],
      creditsConsumed: COST_PER_MESSAGE.toString(),
      balanceRemaining: debitResult.balanceRemaining?.toString(),
    });
  } catch (error: any) {
    console.error('[API v1 Messages] Erreur:', error);
    if (devId) {
      void logTelemetry(devId, keyPrefix, '/api/v1/messages/send', 'POST', 500, Date.now() - startTime);
    }
    return fail('Erreur interne du serveur lors de l\'envoi du message API.', 500);
  }
}

async function logTelemetry(
  developerId: string,
  keyPrefix: string | null,
  endpoint: string,
  method: string,
  statusCode: number,
  latencyMs: number
) {
  try {
    await prisma.developerApiLog.create({
      data: { developerId, keyPrefix, endpoint, method, statusCode, latencyMs },
    });
  } catch {}
}

async function dispatchDeveloperWebhook(
  developerId: string,
  messageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  recipientNumber: string
) {
  try {
    const webhook = await prisma.developerWebhook.findUnique({
      where: { developerId, isActive: true },
    });

    if (!webhook || !webhook.url) return;

    const payload = {
      object: 'alanya_business_account',
      entry: [
        {
          id: developerId,
          changes: [
            {
              value: {
                messaging_product: 'alanya',
                statuses: [
                  {
                    id: messageId,
                    status: status,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    recipient_id: recipientNumber,
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };

    void fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Alanya-Signature': webhook.secretKey || 'v1_sha256',
      },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {}
}
