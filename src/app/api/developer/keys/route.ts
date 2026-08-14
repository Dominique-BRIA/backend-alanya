import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail, handleError } from '@/lib/http';
import { requireUser } from '@/lib/auth-context';
import { generateApiKey } from '@/lib/developer/key-service';
import { ApiKeyType } from '@prisma/client';

// GET /api/developer/keys — Récupère le compte dev, solde et la liste des clés
export async function GET(req: NextRequest) {
  try {
    const { sub: userId } = requireUser(req);

    let devAccount = await prisma.developerAccount.findUnique({
      where: { userId },
      include: {
        apiKeys: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            prefix: true,
            name: true,
            type: true,
            isActive: true,
            lastUsedAt: true,
            createdAt: true,
          },
        },
      },
    });

    // Création automatique du compte dev si première visite (avec 1 000 crédits de bienvenue offerts !)
    if (!devAccount) {
      devAccount = await prisma.developerAccount.create({
        data: {
          userId,
          balanceCredits: BigInt(1000), // 1 000 crédits offerts
          ledger: {
            create: {
              amount: BigInt(1000),
              type: 'PURCHASE',
              description: 'Bonus de bienvenue Développeur (1 000 Crédits offerts)',
            },
          },
        },
        include: {
          apiKeys: true,
        },
      });
    }

    return ok({
      developer: {
        id: devAccount.id,
        balanceCredits: devAccount.balanceCredits.toString(),
        holdCredits: devAccount.holdCredits.toString(),
        companyName: devAccount.companyName ?? null,
      },
      apiKeys: devAccount.apiKeys,
    });
  } catch (error) {
    return handleError(error);
  }
}

// POST /api/developer/keys — Génère une nouvelle clé API
export async function POST(req: NextRequest) {
  try {
    const { sub: userId } = requireUser(req);
    const body = await req.json().catch(() => ({}));
    const name = (body.name?.toString().trim() || 'Ma clé API Développeur').slice(0, 50);
    const type = body.type === 'LIVE' ? ApiKeyType.LIVE : ApiKeyType.SANDBOX;

    // Récupère ou crée le compte dev
    let devAccount = await prisma.developerAccount.findUnique({
      where: { userId },
    });

    if (!devAccount) {
      devAccount = await prisma.developerAccount.create({
        data: {
          userId,
          balanceCredits: BigInt(1000),
          ledger: {
            create: {
              amount: BigInt(1000),
              type: 'PURCHASE',
              description: 'Bonus de bienvenue Développeur (1 000 Crédits offerts)',
            },
          },
        },
      });
    }

    // Génération cryptographique de la clé
    const { rawKey, keyHash, prefix } = generateApiKey(type);

    const apiKey = await prisma.apiKey.create({
      data: {
        developerId: devAccount.id,
        name,
        keyHash,
        prefix,
        type,
      },
    });

    return ok({
      message: 'Clé API générée avec succès. Conservez-la en lieu sûr !',
      // ⚠️ rawKey est renvoyé UNE SEULE ET UNIQUE FOIS ici !
      rawKey,
      apiKey: {
        id: apiKey.id,
        prefix: apiKey.prefix,
        name: apiKey.name,
        type: apiKey.type,
        createdAt: apiKey.createdAt,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}

// DELETE /api/developer/keys — Révoque/désactive une clé API
export async function DELETE(req: NextRequest) {
  try {
    const { sub: userId } = requireUser(req);
    const body = await req.json().catch(() => ({}));
    const keyId = body.keyId?.toString();

    if (!keyId) return fail('Paramètre keyId requis', 400);

    const devAccount = await prisma.developerAccount.findUnique({
      where: { userId },
    });

    if (!devAccount) return fail('Compte développeur introuvable', 404);

    await prisma.apiKey.updateMany({
      where: { id: keyId, developerId: devAccount.id },
      data: { isActive: false },
    });

    return ok({ message: 'Clé API révoquée avec succès.' });
  } catch (error) {
    return handleError(error);
  }
}
