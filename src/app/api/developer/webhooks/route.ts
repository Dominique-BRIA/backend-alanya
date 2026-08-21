import crypto from 'crypto';
import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { ok, fail } from '@/lib/http';
import { withAuth } from '@/lib/auth-context';

/*
 * 🔴 `secretKey` NE SORT PLUS D'ICI EN LECTURE.
 *
 * `GET` le rendait dans sa réponse. Un secret de signature qui se relit est un
 * secret qui finit dans un cache de navigateur, dans une capture d'écran de
 * console et dans les journaux du relais du tableau de bord — exactement ce que
 * la clé API évite déjà en n'étant montrée qu'UNE fois à sa création.
 *
 * Même règle ici : le secret n'est rendu qu'au moment où il est POSÉ, et jamais
 * plus. La lecture ne dit que s'il en existe un.
 */

// GET /api/developer/webhooks — Récupérer la configuration Webhook Développeur
export const GET = withAuth(async (req: NextRequest, userId: string) => {
  try {
    let developer = await prisma.developerAccount.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!developer) {
      developer = await prisma.developerAccount.create({
        data: { userId },
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

    if (!webhook) return ok({ webhook: null });

    const { secretKey, ...sansSecret } = webhook;
    return ok({ webhook: { ...sansSecret, secretKeyDefini: Boolean(secretKey) } });
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
        data: { userId },
        select: { id: true },
      });
    }

    const body = await req.json().catch(() => ({}));
    const url = body.url?.toString().trim();
    const verifyToken = body.verifyToken?.toString().trim() || null;
    const isActive = body.isActive !== false;

    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return fail('Une URL HTTP/HTTPS valide est requise pour le Webhook.', 400);
    }

    /*
     * Le secret est TIRÉ PAR NOUS quand il n'en existe pas encore.
     *
     * Il pouvait rester `null`, et il l'était en pratique : la signature partait
     * alors avec le littéral `'v1_sha256'`. Un secret absent donnait donc un
     * récepteur qui croit vérifier quelque chose. 32 octets d'aléa
     * cryptographique valent mieux qu'une chaîne choisie à la main.
     *
     * ⚠️ L'ORDRE DES REPLIS EST CE QUI COMPTE : secret fourni → secret existant
     * → tirage. Tirer dès que le corps n'en porte pas ferait ROULER le secret à
     * chaque simple changement d'URL, et casserait silencieusement un récepteur
     * déjà en service — une rotation doit être demandée, jamais subie.
     */
    const existant = await prisma.developerWebhook.findUnique({
      where: { developerId: developer.id },
      select: { secretKey: true },
    });
    const secretFourni = body.secretKey?.toString().trim() || null;
    const secretKey = secretFourni || existant?.secretKey || crypto.randomBytes(32).toString('hex');
    /** Vrai seulement quand l'appelant peut découvrir le secret dans la réponse. */
    const secretNouveau = secretFourni !== null || !existant?.secretKey;

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
        isActive: true,
        createdAt: true,
      },
    });

    return ok({
      webhook: { ...webhook, secretKeyDefini: true },
      // ⚠️ Rendu UNE SEULE FOIS, comme `rawKey` à la création d'une clé API —
      // et seulement quand il vient d'être posé ou remplacé.
      ...(secretNouveau ? { secretKey } : {}),
      message: secretNouveau
        ? 'Configuration Webhook enregistrée. Conservez le secret : il ne sera plus jamais affiché.'
        : 'Configuration Webhook enregistrée. Le secret existant est conservé.',
    });
  } catch (error: any) {
    console.error('[API Developer Webhook] Erreur POST:', error);
    return fail('Erreur d\'enregistrement de la configuration Webhook', 500);
  }
});
