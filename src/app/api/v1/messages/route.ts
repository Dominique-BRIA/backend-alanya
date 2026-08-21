import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { ok, fail, handleError } from '@/lib/http';
import { routeV1, type CleAuthentifiee } from '@/lib/developer/authentifier';
import { CODE, statutPublic } from '@/lib/developer/api-contract';
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
    /*
     * Boutons de réponse rapide — « Veux-tu manger ? [OUI] [NON] ».
     *
     * ⚠️ UN LIBELLÉ NE PEUT PAS CONTENIR DE CROCHET. Les deux clients
     * reconnaissent un bouton par `\[([^\]]+)\]` : un crochet dans le libellé
     * couperait le bouton au mauvais endroit, ou en fabriquerait deux. Le
     * refuser ici vaut mieux que de livrer un message que personne ne peut
     * afficher correctement.
     *
     * 24 caractères : c'est un libellé de bouton dans une bulle de
     * conversation, sur un téléphone. Au-delà il déborde ou se tronque, et le
     * texte du bouton EST ce que l'utilisateur nous renverra.
     */
    options: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(24)
          .refine((o) => !o.includes('[') && !o.includes(']'), {
            message: 'Un libellé de bouton ne peut pas contenir de crochet',
          }),
      )
      .min(1)
      .max(10)
      .optional(),
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
  })
  /*
   * 🔴 PAS DE BOUTONS SUR UN CONTACT NI UNE LOCATION. Leur `content` est du
   * JSON : y ajouter « \n[OUI] [NON] » le rendrait illisible, et le message
   * deviendrait inaffichable chez les trois clients. Le refus est explicite
   * plutôt que silencieux — cette charge est validée par `chargeValide` juste
   * au-dessus, elle échouerait donc de toute façon, mais avec un message qui
   * ne dirait pas la vraie cause.
   */
  .refine((d) => !d.options?.length || (d.type !== 'CONTACT' && d.type !== 'LOCATION'), {
    message: 'Les boutons ne s\'appliquent pas à un message CONTACT ou LOCATION',
    path: ['options'],
  })
  // Des boutons sans question n'ont rien à quoi répondre.
  .refine((d) => !d.options?.length || Boolean(d.texte), {
    message: 'Des options exigent un texte : le bouton répond à une question',
    path: ['options'],
  });

/**
 * Encode les boutons dans le texte, au format que les DEUX clients lisent déjà.
 *
 * 🔴 LE FORMAT EST UNE CONVENTION D'AFFICHAGE, PAS UN CHAMP. Web
 * (`chat.tsx`) et mobile (`chat_screen.dart`) cherchent tous deux
 * `\[([^\]]+)\]` dans `content`, affichent chaque occurrence en pastille
 * cliquable et la retirent du texte rendu. Un clic renvoie le libellé comme
 * message texte ordinaire.
 *
 * L'appelant n'a pas à connaître cette convention : il envoie
 * `options: ["OUI", "NON"]` et c'est nous qui composons. C'est tout l'intérêt
 * de le faire ici — le jour où les clients gagnent un vrai type de message
 * pour les boutons, l'API ne bouge pas.
 *
 * ⚠️ CONSÉQUENCE À CONNAÎTRE, indépendante de cette fonction : **tout crochet
 * dans un texte devient un bouton chez les trois clients.** « Votre commande
 * [12345] est prête » affiche un bouton « 12345 » et perd le numéro dans la
 * phrase. C'est un défaut des clients, pas de l'API — mais il vaut mieux le
 * savoir avant d'envoyer une campagne.
 */
function composerTexteAvecOptions(texte: string, options: string[]): string {
  return `${texte}\n${options.map((o) => `[${o}]`).join(' ')}`;
}

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

  const contenu =
    corps.options?.length && corps.texte
      ? composerTexteAvecOptions(corps.texte, corps.options)
      : corps.texte;

  const envoi = await creerMessage({
    convId: conversation.id,
    expediteurId: cle.userId,
    type: corps.type,
    content: contenu,
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

  /*
   * ⚠️ Le statut est LU sur la ligne créée, pas écrit en dur.
   *
   * Les deux valeurs partaient en littéral `'ENVOYE'` — la réponse et le
   * webhook auraient continué d'annoncer « envoyé » le jour où `creerMessage`
   * poserait autre chose. `statutPublic` traduit `Message.status`, qui reste en
   * anglais en base, et la traduction n'a lieu qu'ici, à la frontière.
   */
  const statut = statutPublic(message.status);

  void notifierStatutMessage(cle.developerId, message.id, statut, destinataire.publicNumber);

  return ok(
    {
      id: message.id,
      statut,
      destinataire: destinataire.publicNumber,
      conversationId: conversation.id,
      type: message.type,
      medias: message.media.map((f) => ({ id: f.id, url: `/api/media/${f.id}` })),
      // Rendues telles qu'envoyées : l'appelant retrouve ainsi les libellés
      // exacts qu'il devra reconnaître dans la réponse de l'utilisateur.
      ...(corps.options?.length ? { options: corps.options } : {}),
      envoyeA: message.createdAt.toISOString(),
    },
    201,
  );
}
