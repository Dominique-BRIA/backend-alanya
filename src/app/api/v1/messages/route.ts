import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ok, fail, handleError } from '@/lib/http';
import { routeV1, type CleAuthentifiee } from '@/lib/developer/authentifier';
import { CODE } from '@/lib/developer/api-contract';
import { notifierStatutMessage } from '@/lib/developer/webhook';
import { findOrCreateDirectConversation } from '@/modules/messaging/access';
import { creerMessage } from '@/modules/messaging/envoi';
import { chargeValide } from '@/lib/message-payload.mjs';

const CHEMIN = '/api/v1/messages';

/**
 * POST /api/v1/messages — envoie un message à un utilisateur Alanya.
 *
 * 🔴 CETTE ROUTE REMPLACE `POST /api/v1/messages/send`, SUPPRIMÉE. Personne
 * n'avait encore intégré l'API : c'était la dernière occasion de la corriger
 * sans coûter une reprise à qui que ce soit.
 *
 * Ce qui change, et pourquoi :
 *
 * - **Plus d'imitation de WhatsApp Cloud API.** L'ancienne route acceptait
 *   `to` / `recipientNumber` / `phone` pour la même chose, et `text.body` /
 *   `content` / `text` pour la même autre — une cascade de `||` où toute faute
 *   de frappe devenait un champ vide plutôt qu'une erreur. Elle répondait en
 *   plus `wa_id` et `messaging_product`, qui annonçaient un WhatsApp qui
 *   n'existe pas. **Un nom par champ.**
 * - **L'identifiant est l'identifiant.** Plus de préfixe `wamid.` à retirer
 *   pour retrouver la ligne `message`.
 * - **201 et non 200** : la requête crée une ressource.
 * - **Zod**, comme les 101 autres routes du backend, donc un 422 uniforme
 *   portant `err.flatten()` au lieu d'un 400 maison.
 * - **La séquence d'envoi est partagée** avec la route de conversation
 *   (`creerMessage`) : l'API hérite d'un coup du contrôle de blocage, des
 *   messages éphémères et de `lastMessageType`, dont elle était privée.
 */

/**
 * ⚠️ `destinataire` n'est PAS `publicNumberSchema`.
 *
 * La recherche accepte le numéro public Alanya **ou** le mobile, et un mobile
 * n'a pas la forme d'un Alanya ID. Imposer ici le format strict rejetterait un
 * numéro que la couche du dessous sait pourtant résoudre.
 */
const envoiV1Schema = z
  .object({
    destinataire: z.string().trim().min(3).max(30),
    type: z
      .enum(['TEXT', 'IMAGE', 'FILE', 'AUDIO', 'VIDEO', 'CONTACT', 'LOCATION'])
      .default('TEXT'),
    texte: z.string().trim().min(1).max(8000).optional(),
    mediaIds: z.array(z.string().uuid()).max(10).optional(),
  })
  // Le format des charges CONTACT / LOCATION est tenu par `message-payload.mjs`,
  // le seul module que les trois clients traversent. On le réutilise plutôt que
  // de redire la règle ici, où elle divergerait.
  .refine((d) => chargeValide(d.type, d.texte ?? null), {
    message: 'Charge invalide : un message CONTACT ou LOCATION porte sa charge JSON dans texte',
    path: ['texte'],
  })
  // Un message sans texte ET sans média ne peut rien afficher chez personne.
  .refine((d) => Boolean(d.texte) || Boolean(d.mediaIds?.length), {
    message: 'Un message doit porter un texte ou au moins un média',
    path: ['texte'],
  });

export async function POST(req: NextRequest) {
  return routeV1(req, { chemin: CHEMIN, plafondParMinute: 60 }, (cle) => envoyer(req, cle));
}

async function envoyer(req: NextRequest, cle: CleAuthentifiee): Promise<Response> {
  let corps: z.infer<typeof envoiV1Schema>;
  try {
    corps = envoiV1Schema.parse(await req.json().catch(() => ({})));
  } catch (erreur) {
    // `handleError` rend le 422 `{ error: { message, code: "VALIDATION", details } }`
    // que tout le reste du backend rend déjà pour une faute de forme.
    return handleError(erreur);
  }

  const destinataire = await prisma.user.findFirst({
    where: { OR: [{ publicNumber: corps.destinataire }, { mobile: corps.destinataire }] },
    select: { id: true, publicNumber: true },
  });

  if (!destinataire) {
    return fail(
      `Aucun compte Alanya pour le numéro ${corps.destinataire}.`,
      404,
      CODE.DESTINATAIRE_INTROUVABLE,
    );
  }

  /*
   * ⚠️ `findOrCreateDirectConversation` et non un filtre réécrit ici.
   *
   * L'ancienne route cherchait la conversation avec
   * `participants: { every: { userId: { in: [...] } } }`. `every` est vrai pour
   * tout SOUS-ENSEMBLE : la conversation « Moi » de l'expéditeur, qui ne porte
   * qu'un participant, le satisfaisait — les envois API pouvaient donc atterrir
   * chez l'expéditeur lui-même, sans la moindre erreur.
   */
  const conversation = await findOrCreateDirectConversation(cle.userId, destinataire.id);

  const envoi = await creerMessage({
    convId: conversation.id,
    expediteurId: cle.userId,
    type: corps.type,
    content: corps.texte,
    mediaIds: corps.mediaIds,
  });

  if (!envoi.ok) {
    if (envoi.motif === 'MEDIA_ETRANGER') {
      return fail(
        'Un des médias est inconnu ou n\'a pas été téléversé par cette clé.',
        403,
        CODE.MEDIA_INTERDIT,
      );
    }
    /*
     * 🔴 CONTRÔLE QUE L'API N'AVAIT PAS. Le client le fait, le WebSocket le
     * fait, la route HTTP de conversation le fait — l'API était la seule porte
     * par laquelle on pouvait écrire à quelqu'un qui vous a bloqué.
     */
    return fail('Destinataire non joignable.', 403, CODE.DESTINATAIRE_BLOQUE);
  }

  const message = envoi.message;

  // Notification poussée — propre à l'API : contrairement au client, personne
  // n'est à l'écran pour la déclencher.
  try {
    const { sendPushToUser } = await import('@/../push.mjs');
    await sendPushToUser(prisma, destinataire.id, {
      title: 'Nouveau message Alanya',
      body: corps.texte ?? '',
      data: { convId: conversation.id, messageId: message.id, type: 'chat_message' },
    });
  } catch {
    // Ignorer si Push n'est pas configuré.
  }

  void notifierStatutMessage(cle.developerId, message.id, 'ENVOYE', destinataire.publicNumber);

  return ok(
    {
      id: message.id,
      statut: 'ENVOYE',
      destinataire: destinataire.publicNumber,
      conversationId: conversation.id,
      type: message.type,
      medias: message.media.map((f) => ({ id: f.id, url: `/api/media/${f.id}` })),
      envoyeA: message.createdAt.toISOString(),
    },
    201,
  );
}
