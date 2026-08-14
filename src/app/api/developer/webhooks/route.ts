import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { withAuth } from '@/lib/auth-context';

// GET /api/developer/webhooks — Récupérer la configuration Webhook Développeur
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    let developer = await prisma.developerAccount.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!developer) {
      developer = await prisma.developerAccount.create({
        data: { userId, balanceCredits: BigInt(1000) },
        select: { id: true },
      });
    }

    const webhook = await prisma.developerWebhook.findUnique({
      where: { developerId: developer.id },
      select: {
        id: true,
        url: true,
        verifyToken: true,
        secretKey: true,
        isActive: true,
        createdAt: true,
      },
    });

    return ok({ webhook: webhook || null });
  } catch (error: any) {
    console.error('[API Developer Webhook] Erreur GET:', error);
    return fail('Erreur lors de la récupération de la configuration Webhook', 500);
  }
});

// POST /api/developer/webhooks — Configurer l'URL Webhook Développeur (Standard WhatsApp)
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    let developer = await prisma.developerAccount.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!developer) {
      developer = await prisma.developerAccount.create({
        data: { userId, balanceCredits: BigInt(1000) },
        select: { id: true },
      });
    }

    const body = await req.json().catch(() => ({}));
    const url = body.url?.toString().trim();
    const verifyToken = body.verifyToken?.toString().trim() || null;
    const secretKey = body.secretKey?.toString().trim() || null;
    const isActive = body.isActive !== false;

    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return fail('Une URL HTTP/HTTPS valide est requise pour le Webhook.', 400);
    }

    const webhook = await prisma.developerWebhook.upsert({
      where: { developerId: developer.id },
      create: {
        developerId: developer.id,
        url,
        verifyToken,
        secretKey,
        isActive,
      },
      update: {
        url,
        verifyToken,
        secretKey,
        isActive,
      },
      select: {
        id: true,
        url: true,
        verifyToken: true,
        secretKey: true,
        isActive: true,
        createdAt: true,
      },
    });

    return ok({ webhook, message: 'Configuration Webhook enregistrée avec succès.' });
  } catch (error: any) {
    console.error('[API Developer Webhook] Erreur POST:', error);
    return fail('Erreur d\'enregistrement de la configuration Webhook', 500);
  }
});
