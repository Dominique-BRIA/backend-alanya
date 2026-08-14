import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { validateApiKey } from '@/lib/developer/key-service';

// POST /api/v1/media — Upload de média conforme WhatsApp Cloud API (obtention d'un media_id)
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const customHeader = req.headers.get('X-Api-Key') || '';
    const rawKey = authHeader.replace(/^Bearer\s+/i, '') || customHeader;

    if (!rawKey) {
      return fail('Clé API manquante.', 401);
    }

    const keyData = await validateApiKey(rawKey);
    if (!keyData || !keyData.developer) {
      return fail('Clé API invalide ou révoquée.', 401);
    }

    const developer = keyData.developer;
    const body = await req.json().catch(() => ({}));
    const fileUrl = body.url || body.link || body.fileUrl;
    const mimeType = body.mimeType || body.messaging_product || 'image/png';

    if (!fileUrl) {
      return fail('Le champ url (URL du fichier) est requis.', 400);
    }

    const media = await prisma.developerMedia.create({
      data: {
        developerId: developer.id,
        url: fileUrl,
        mimeType,
        size: body.size || 1024,
      },
      select: {
        id: true,
        url: true,
        mimeType: true,
        createdAt: true,
      },
    });

    return ok({
      id: media.id,
      media_id: media.id,
      url: media.url,
      mime_type: media.mimeType,
      messaging_product: 'alanya',
    });
  } catch (error: any) {
    console.error('[API Media Upload] Erreur:', error);
    return fail('Erreur d\'enregistrement du média', 500);
  }
}
