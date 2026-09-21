import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { sendMessageSchema } from "@/lib/validation";
import { MEDIA_ORDONNE } from "@/lib/media-ordre";
import { assertParticipant } from "@/modules/messaging/access";
import { creerMessage, serialiserMessage } from "@/modules/messaging/envoi";
import {
  reserverEnvoi,
  confirmerEnvoi,
  annulerEnvoi,
  tempIdValide,
} from "@/lib/idempotence.mjs";

const PAGE_SIZE = 50;

// GET /api/conversations/:id/messages?cursor=<messageId>&limit=50
// Historique paginé (curseur), du plus récent au plus ancien.
export const GET = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  // F10 : remet le compteur de non-lus à 0 quand l'utilisateur ouvre la conversation
  await prisma.participant.update({
    where: { convId_userId: { convId, userId } },
    data: { unreadCount: 0 },
  });

  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? PAGE_SIZE), 100);

  // Réglage « messages éphémères » de la conversation (exposé à l'app).
  const convCfg = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { disappearingSeconds: true },
  });

  // Blocage : masque à la lecture les messages des utilisateurs avec qui je suis
  // bloqué (dans un sens ou l'autre) → le blocage est silencieux et effectif.
  const blockedRows = await prisma.blocked.findMany({
    where: { OR: [{ alanyaID: userId }, { idCallerBlock: userId }] },
    select: { alanyaID: true, idCallerBlock: true },
  });
  const blockedIds = [
    ...new Set(
      blockedRows.map((b) => (b.alanyaID === userId ? b.idCallerBlock : b.alanyaID)),
    ),
  ];

  const messages = await prisma.message.findMany({
    where: {
      convId,
      // On GARDE les messages supprimés (deletedAt != null) pour afficher le
    // placeholder « Ce message a été supprimé ». On EXCLUT seulement les
    // messages que CET utilisateur a masqués (« supprimer pour moi »).
      hides: { none: { userId } },
      // Messages éphémères arrivés à expiration : masqués à la lecture (la purge
      // définitive est faite périodiquement par le serveur WS).
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      ...(blockedIds.length > 0 ? { senderId: { notIn: blockedIds } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      // Sans tri explicite, la grille de photos se réordonne à chaque lecture —
      // voir `src/lib/media-ordre.ts`.
      media: MEDIA_ORDONNE,
      reactions: { select: { userId: true, emoji: true } },
      stars: { where: { userId }, select: { id: true } },
      // Les mentions `@` : sans elles ici, un message relu depuis l'historique
      // perdrait sa mise en évidence — elle n'apparaîtrait que sur les messages
      // arrivés en temps réel, ce qui ressemblerait à un défaut d'affichage.
      mentions: { select: { userId: true, libelle: true } },
    },
  });

  const hasMore = messages.length > limit;
  const page = hasMore ? messages.slice(0, limit) : messages;

  /**
   * Pseudos d'appareil, pour MES propres messages seulement.
   *
   * Le pseudo dit quel appareil du compte a écrit ; il ne regarde que ce
   * compte. On ne le charge donc que pour les messages dont je suis
   * l'expéditeur — les autres n'ont même pas à être interrogés, et le champ
   * n'apparaîtra pas dans leur charge. Le filtrage est ici, pas côté client.
   */
  const mesAppareils = [
    ...new Set(
      page
        .filter((m) => m.senderId === userId && m.appareilId != null)
        .map((m) => m.appareilId as number),
    ),
  ];
  const pseudoParAppareil = new Map<number, string>();
  if (mesAppareils.length > 0) {
    const lignes = await prisma.appareil.findMany({
      // alanyaId en plus de l'id : la ceinture et les bretelles, au cas où un
      // message porterait l'appareil d'un autre compte.
      where: { appareilId: { in: mesAppareils }, alanyaId: userId },
      select: { appareilId: true, agent: true },
    });
    for (const l of lignes) {
      if (l.agent) pseudoParAppareil.set(l.appareilId, l.agent);
    }
  }

  // --- Snapshots des messages cités (replyTo) ---
  // On récupère en une seule requête tous les messages référencés par replyToId,
  // pour pouvoir afficher l'aperçu côté UI même si le message original n'est pas
  // chargé en mémoire locale.
  const replyIds = [...new Set(
    page.map((m) => m.replyToId).filter(Boolean) as string[],
  )];
  const replyTargets = replyIds.length > 0
    ? await prisma.message.findMany({
        where: { id: { in: replyIds } },
        select: { id: true, senderId: true, content: true, type: true, deletedAt: true },
      })
    : [];
  const replyMap = new Map(replyTargets.map((t) => [t.id, t]));

  // --- Statuts cités ---
  // Même principe que les messages cités, en une seule requête pour la page.
  // ⚠️ L'aperçu est celui RECOPIÉ à l'envoi, pas le statut vivant : celui-ci a
  // pu expirer ou être supprimé depuis, et la conversation doit garder son sens.
  const citations = await prisma.statusReplyQuote.findMany({
    where: { messageId: { in: page.map((m) => m.id) } },
  });
  const citationParMessage = new Map(citations.map((c) => [c.messageId, c]));

  return ok({
    messages: page.map((m) => {
      let replyTo = null;
      if (m.replyToId && replyMap.has(m.replyToId)) {
        const t = replyMap.get(m.replyToId)!;
        replyTo = {
          id: m.replyToId,
          senderId: t.senderId,
          type: t.type,
          content: t.deletedAt ? null : t.content,
          isDeleted: t.deletedAt !== null,
        };
      }
      return {
        id: m.id,
        convId: m.convId,
        senderId: m.senderId,
        content: m.content,
        type: m.type,
        status: m.status,
        // 🐛 LE MESSAGE PORTAIT SON APPEL EN BASE, ET NE LE DISAIT PAS.
        // `creerMessage` ecrit bien `callId` pour une messagerie vocale — mais
        // aucun des trois serialiseurs ne le rendait. Cote client, une
        // messagerie etait donc indiscernable d'un fichier audio ordinaire :
        // elle s'affichait avec son nom de fichier et sa taille, et le bloc qui
        // devait la coller a son appel manque ne se formait jamais.
        // Meme classe de defaut que l'URL de l'accueil : la donnee est ecrite,
        // et le chemin qui la rend l'oublie.
        callId: m.callId ?? null,
        replyToId: m.replyToId,
        replyTo,
        statutCite: (() => {
          const c = citationParMessage.get(m.id);
          if (!c) return null;
          return {
            statusId: c.statusId,
            authorId: c.authorId,
            type: c.type,
            text: c.text,
            mediaUrl: c.mediaUrl,
            bgColor: c.bgColor,
          };
        })(),
        deletedAt: m.deletedAt,
        editedAt: m.editedAt,
        expiresAt: m.expiresAt,
        starred: m.stars.length > 0,
        reactions: m.reactions.map((r) => ({ userId: r.userId, emoji: r.emoji })),
        mentions: m.mentions.map((x) => ({ userId: x.userId, libelle: x.libelle })),
        // La mention collective voyage a cote des nominatives. Un client qui ne
        // la connait pas l'ignore et affiche le texte sans surlignage.
        mentionneTous: m.mentionneTous === true,
        mentionTousLibelle: m.mentionTousLibelle ?? null,
        media: m.media.map((f) => ({
          id: f.id,
          url: `/api/media/${f.id}`,
          filename: f.filename,
          mimeType: f.mimeType,
          sizeBytes: f.sizeBytes,
          durationMs: f.durationMs,
        })),
        createdAt: m.createdAt,
        // Absent — et non pas vide — quand le lecteur n'a pas à le voir.
        // Le pseudo ET l'appareil qui a envoyé, dans la même charge restreinte
        // au compte. L'appareil sert au client à se reconnaître : un poste
        // n'affiche pas son propre nom au-dessus de ses propres messages.
        ...(m.senderId === userId && m.appareilId != null && pseudoParAppareil.has(m.appareilId)
          ? { nomAgent: pseudoParAppareil.get(m.appareilId), appareilId: m.appareilId }
          : {}),
      };
    }),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
    disappearingSeconds: convCfg?.disappearingSeconds ?? 0,
  });
});

/** La citation d'un statut, telle qu'elle part au client. */
function serialiserCitation(c: {
  statusId: string;
  authorId: string;
  type: string;
  text: string | null;
  mediaUrl: string | null;
  bgColor: string | null;
}) {
  return {
    statusId: c.statusId,
    authorId: c.authorId,
    type: c.type,
    text: c.text,
    mediaUrl: c.mediaUrl,
    bgColor: c.bgColor,
  };
}

/**
 * Le message déjà écrit sous cette réservation, prêt à être renvoyé — ou `null`
 * s'il a disparu depuis.
 *
 * ⚠️ LA RÉPONSE DOIT ÊTRE LA MÊME QUE CELLE DU PREMIER ENVOI, citation
 * comprise. Un client qui rejoue reçoit ainsi exactement ce qu'il attendait, et
 * retire son entrée de la file. Lui répondre un corps appauvri l'obligerait à
 * recharger la conversation pour retrouver l'aperçu.
 *
 * ⚠️ `null` EST UN CAS NORMAL : la réservation dure vingt-quatre heures, et le
 * message peut avoir été supprimé entre-temps. L'appelant laisse alors l'envoi
 * suivre son cours ordinaire — mieux vaut un message réécrit qu'un message
 * perdu.
 */
async function messageDejaEcrit(messageId: string) {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { media: true, mentions: true },
  });
  if (!message) return null;

  const citation = await prisma.statusReplyQuote.findUnique({
    where: { messageId: message.id },
  });

  return {
    ...serialiserMessage(message),
    statutCite: citation ? serialiserCitation(citation) : null,
  };
}

// POST /api/conversations/:id/messages — envoie un message dans la conversation.
export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: convId } = await ctx.params;
  await assertParticipant(convId, userId);

  const body = sendMessageSchema.parse(await req.json());

  /*
   * QU'UN REJEU N'ÉCRIVE PAS UN SECOND MESSAGE.
   *
   * 🔴 C'est PAR ICI que passe la file d'envois du mobile (`outbox.dart`), et
   * non par la socket. Elle ne retire son entrée qu'une fois la réponse reçue :
   * une coupure survenue APRÈS l'écriture mais AVANT la réponse lui fait croire
   * à un échec, et elle rejoue. Sans la réservation qui suit, le message part
   * une seconde fois.
   *
   * ⚠️ UN CLIENT SANS `tempId` PASSE COMME AVANT. Les APK déjà installés n'en
   * envoient pas ; leur refuser l'envoi serait échanger un doublon occasionnel
   * contre une panne totale.
   */
  const tempId = tempIdValide(body.tempId);
  const reservation = await reserverEnvoi(userId, tempId);
  if (!reservation.reserve) {
    if (!reservation.messageId) {
      /*
       * Le même envoi est en train de s'écrire, ailleurs. On ne peut pas encore
       * rendre le message — il n'existe pas — et rendre un succès vide ferait
       * retirer l'entrée de la file pour un message peut-être jamais écrit. Le
       * client réessaiera, et trouvera alors la réservation complète.
       */
      return fail("Envoi déjà en cours", 409, "ENVOI_EN_COURS");
    }
    const dejaEcrit = await messageDejaEcrit(reservation.messageId);
    // La réservation survit vingt-quatre heures, le message peut avoir été
    // supprimé entre-temps : on laisse alors l'envoi suivre son cours normal.
    if (dejaEcrit) return ok(dejaEcrit, 200);
  }

  /*
   * La séquence d'envoi vit dans `creerMessage` — contrôle de blocage, messages
   * éphémères, liaison des médias, `lastMessage`, compteurs de non-lus.
   *
   * Elle en a été EXTRAITE plutôt que recopiée : l'API v1 avait sa propre
   * version, qui avait perdu quatre de ces cinq éléments en chemin. Voir
   * `src/modules/messaging/envoi.ts`.
   *
   * ⚠️ Sur le blocage, on répond 403 et non 200 : c'est le client qui, le
   * connaissant, n'envoie rien. Cette route est le repli utilisé quand le
   * WebSocket n'acquitte pas — c'est-à-dire exactement ce qui se produit entre
   * deux personnes bloquées. Sans ce refus, le repli serait une porte dérobée.
   */
  const envoi = await creerMessage({
    convId,
    expediteurId: userId,
    type: body.type,
    content: body.content,
    mediaId: body.mediaId,
    mediaIds: body.mediaIds,
    replyToId: body.replyToId,
    statutCite: body.statutCite,
    mentions: body.mentions,
    mentionneTous: body.mentionneTous,
    mentionTousLibelle: body.mentionTousLibelle,
    chiffre: body.chiffre,
  });

  if (!envoi.ok) {
    /*
     * 🔴 LIBÉRER LA RÉSERVATION, SANS QUOI L'ÉCHEC DEVIENDRAIT DÉFINITIF.
     * Aucun message n'a été écrit ; garder la clé vingt-quatre heures ferait
     * répondre « déjà envoyé » à chaque rejeu, pour un message qui n'existe
     * nulle part — soit exactement le contraire de ce que la file du mobile
     * doit permettre.
     */
    await annulerEnvoi(userId, tempId);

    if (envoi.motif === "MEDIA_ETRANGER") {
      return fail("Média inconnu ou non possédé", 403, "MEDIA_FORBIDDEN");
    }
    // Seule une charge CONTACT/LOCATION peut arriver ici : le texte ordinaire
    // est coupé silencieusement, jamais refusé.
    if (envoi.motif === "CONTENU_TROP_LONG") {
      return fail("Charge trop longue (500 caractères maximum)", 422, "CONTENT_TOO_LONG");
    }
    /*
     * ⚠️ CES DEUX MOTIFS DOIVENT ÊTRE DISTINGUÉS DE « BLOCKED », qui veut dire
     * « cette personne vous a bloqué ». Les confondre enverrait quelqu'un
     * chercher un blocage qui n'existe pas, alors que son client est
     * simplement trop ancien pour écrire dans un fil chiffré.
     */
    if (envoi.motif === "CONVERSATION_CHIFFREE") {
      return fail(
        "Cette conversation est chiffrée de bout en bout : ce client ne sait " +
          "pas encore y écrire.",
        409,
        "CONVERSATION_CHIFFREE",
      );
    }
    if (envoi.motif === "CONTENU_EN_CLAIR") {
      return fail(
        "Un message chiffré ne doit porter aucun contenu en clair.",
        400,
        "CONTENU_EN_CLAIR",
      );
    }
    return fail("Message non distribuable", 403, "BLOCKED");
  }

  // Le message existe : le rejeu qui arriverait maintenant recevra celui-ci.
  await confirmerEnvoi(userId, tempId, envoi.message.id);

  /*
   * La citation part AVEC la réponse, et pas seulement au rechargement.
   *
   * Sans ça, la bulle apparaît d'abord sans son aperçu et le gagne quelques
   * secondes plus tard — un clignotement que l'utilisateur lit comme un défaut.
   * Elle est relue en base plutôt que recopiée depuis la requête : c'est le
   * serveur qui décide ce qui a été cité, et lui seul.
   */
  const citation = body.statutCite
    ? await prisma.statusReplyQuote.findUnique({
        where: { messageId: envoi.message.id },
      })
    : null;

  return ok(
    {
      ...serialiserMessage(envoi.message),
      statutCite: citation ? serialiserCitation(citation) : null,
    },
    201,
  );
});
