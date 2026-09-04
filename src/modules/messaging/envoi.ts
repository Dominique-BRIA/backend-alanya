import { prisma } from "@/lib/prisma";
import { apercuMessage, tronqueContenu } from "@/lib/message-payload.mjs";
import { peutVoirStatutsDe } from "@/lib/statut-visibilite";

/**
 * LE CŒUR D'ENVOI D'UN MESSAGE — partagé par la route de conversation et par
 * l'API v1.
 *
 * 🔴 POURQUOI IL EXISTE. `POST /api/v1/messages/send` avait sa propre copie de
 * cette séquence, et elle en avait perdu QUATRE morceaux en chemin :
 *
 * 1. **Aucun contrôle de blocage.** Un porteur de clé pouvait écrire à
 *    quelqu'un qui l'avait bloqué — ce que le client refuse, ce que le
 *    WebSocket refuse, et ce que la route HTTP refuse aussi. L'API était la
 *    seule porte restée ouverte.
 * 2. **Les messages éphémères étaient ignorés** : `expiresAt` n'était jamais
 *    posé, donc un message envoyé par l'API dans une conversation à
 *    effacement automatique y restait pour toujours.
 * 3. **Les médias étaient liés à la main** (`mediaFile.create` avec une taille
 *    inventée) au lieu de la relation `media: { connect: … }`.
 * 4. **`lastMessageType` et `lastMessageStatus` n'étaient pas écrits**, alors
 *    que les trois clients s'en servent pour l'icône de la liste.
 *
 * Une copie perd toujours quelque chose. Celle-ci en avait perdu quatre choses
 * en un seul fichier — d'où cette fonction, qui est désormais **le seul endroit
 * où un message naît** hors du WebSocket et du transfert.
 */

/** Les types qu'un appelant peut créer. `SYSTEM` est réservé au serveur. */
export type TypeMessage =
  | "TEXT"
  | "IMAGE"
  | "FILE"
  | "AUDIO"
  | "VIDEO"
  | "CONTACT"
  | "LOCATION";

export type ResultatEnvoi =
  | { ok: true; message: Awaited<ReturnType<typeof creerLigneMessage>> }
  | { ok: false; motif: "BLOQUE" | "MEDIA_ETRANGER" | "CONTENU_TROP_LONG" };

/** Isolée pour que `ResultatEnvoi` puisse en déduire le type de retour exact. */
function creerLigneMessage(data: Parameters<typeof prisma.message.create>[0]["data"]) {
  return prisma.message.create({ data, include: { media: true, mentions: true } });
}

/**
 * Les mentions RÉELLEMENT retenues pour un message.
 *
 * 🔴 FILTRÉES SUR LES PARTICIPANTS, et c'est la garde de sécurité de la
 * fonction : le client envoie des identifiants, et rien n'empêcherait d'y
 * glisser celui de quelqu'un qui n'est pas dans le groupe. Une mention
 * acceptée telle quelle enverrait alors une notification à un inconnu, en lui
 * apprenant l'existence d'une conversation à laquelle il n'appartient pas.
 *
 * ⚠️ HORS GROUPE, AUCUNE MENTION N'EST RETENUE. Mentionner la seule autre
 * personne d'un tête-à-tête ne veut rien dire, et le client ne le propose pas :
 * accepter la charge quand même laisserait entrer par l'API ce que l'écran
 * interdit.
 *
 * Le libellé est tronqué à la longueur de la colonne plutôt que refusé : un nom
 * trop long est un défaut d'affichage, pas une raison de perdre le message.
 */
async function mentionsRetenues(params: {
  convId: string;
  expediteurId: string;
  demandees: { userId: string; libelle: string }[];
}): Promise<{ userId: string; libelle: string }[]> {
  const { convId, expediteurId, demandees } = params;
  if (demandees.length === 0) return [];

  const conv = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { isGroup: true },
  });
  if (!conv?.isGroup) return [];

  const membres = new Set(
    (
      await prisma.participant.findMany({
        where: { convId },
        select: { userId: true },
      })
    ).map((p) => p.userId),
  );

  const vus = new Set<string>();
  const retenues: { userId: string; libelle: string }[] = [];
  for (const m of demandees) {
    // Se mentionner soi-même n'a pas de sens et se notifierait tout seul.
    if (m.userId === expediteurId) continue;
    if (!membres.has(m.userId)) continue;
    if (vus.has(m.userId)) continue;
    vus.add(m.userId);
    retenues.push({ userId: m.userId, libelle: m.libelle.slice(0, 80) });
  }
  return retenues;
}

/**
 * Crée un message, met à jour la conversation et les compteurs de non-lus.
 *
 * Ne notifie personne : la diffusion temps réel appartient au WebSocket et la
 * notification poussée à l'appelant qui en a besoin (l'API v1 en a besoin, la
 * route de conversation non — son client est déjà à l'écran).
 */
export async function creerMessage(params: {
  convId: string;
  expediteurId: string;
  type: TypeMessage;
  content?: string | null;
  mediaId?: string;
  mediaIds?: string[];
  replyToId?: string;
  /// Le statut auquel ce message répond.
  ///
  /// ⚠️ LE CLIENT N'ENVOIE QU'UN IDENTIFIANT ; l'aperçu est recopié ICI depuis
  /// la base, après contrôle de visibilité. Laisser le client fournir le texte
  /// et l'image aurait permis de fabriquer une citation qui n'a jamais existé.
  statutCite?: string;
  /// Les comptes visés par une mention `@`, tels que le client les annonce.
  /// Filtrés par [mentionsRetenues] avant d'être écrits.
  mentions?: { userId: string; libelle: string }[];
  /// Le message mentionne TOUT le groupe. Ignoré hors groupe.
  mentionneTous?: boolean;
  /// Le texte tapé après le « @ », sans le « @ ». Sert au surlignage.
  mentionTousLibelle?: string;
}): Promise<ResultatEnvoi> {
  const { convId, expediteurId, type, replyToId } = params;

  // La mention collective n'a de sens qu'en GROUPE, et le libellé est
  // indispensable au surlignage : sans lui, rien à mettre en évidence.
  const conversation = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { isGroup: true },
  });
  const mentionneTous =
    params.mentionneTous === true &&
    conversation?.isGroup === true &&
    (params.mentionTousLibelle ?? "").trim() !== "";

  /*
   * ⚠️ RAMENÉ À LA LONGUEUR DE LA COLONNE AVANT TOUT LE RESTE.
   *
   * `message.content` est un VARCHAR(500) depuis le 25/08/2026 : PostgreSQL
   * REFUSE une valeur plus longue (erreur 22001), il ne la coupe pas. Un texte
   * de 600 caractères serait donc devenu une erreur 500 en bout de course,
   * après le contrôle de blocage, la vérification des médias et la lecture du
   * TTL — trois requêtes pour rien, et un message perdu.
   *
   * La coupe se fait ICI et non dans les schémas zod des appelants : c'est le
   * seul endroit que traversent les trois portes HTTP (conversation, API v1,
   * média v1). Le poser dans les schémas aurait laissé la troisième dehors.
   */
  const longueur = tronqueContenu(type, params.content ?? null);
  if (longueur.refuse) return { ok: false, motif: "CONTENU_TROP_LONG" };
  const content = longueur.contenu;

  /*
   * Blocage. On répond par un refus, jamais par un faux succès : mentir à
   * l'appelant n'est pas le rôle de l'API. Le contrôle ne vaut que pour un
   * tête-à-tête — dans un groupe, un blocage entre deux membres ne retire la
   * parole à personne.
   */
  const participants = await prisma.participant.findMany({
    where: { convId },
    select: { userId: true },
  });
  if (participants.length === 2) {
    const autre = participants.find((p) => p.userId !== expediteurId)?.userId;
    if (autre) {
      const blocage = await prisma.blocked.findFirst({
        where: {
          OR: [
            { alanyaID: expediteurId, idCallerBlock: autre },
            { alanyaID: autre, idCallerBlock: expediteurId },
          ],
        },
        select: { idBlock: true },
      });
      if (blocage) return { ok: false, motif: "BLOQUE" };
    }
  }

  /*
   * ⚠️ LES MÉDIAS DOIVENT APPARTENIR À L'EXPÉDITEUR.
   *
   * `media: { connect: { id } }` accepte n'importe quel identifiant existant :
   * sans ce contrôle, connaître l'UUID d'un fichier suffit à le rattacher à son
   * propre message, donc à le faire lire par le contrôle d'accès de
   * `/api/media/:id` — qui autorise les participants du message porteur.
   * Un identifiant n'est pas un secret ; c'est la propriété qui l'est.
   *
   * (Le TRANSFERT de message ne passe pas par ici : il recopie légitimement le
   * média d'autrui et garde son propre chemin.)
   */
  const idsMedias = params.mediaIds?.length ? params.mediaIds : params.mediaId ? [params.mediaId] : [];
  if (idsMedias.length > 0) {
    const possedes = await prisma.mediaFile.count({
      where: { id: { in: idsMedias }, ownerId: expediteurId },
    });
    if (possedes !== idsMedias.length) return { ok: false, motif: "MEDIA_ETRANGER" };
  }

  // Messages éphémères : l'expiration suit le réglage de la conversation.
  const convCfg = await prisma.conversation.findUnique({
    where: { id: convId },
    select: { disappearingSeconds: true },
  });
  const ttl = convCfg?.disappearingSeconds ?? 0;
  const expiresAt = ttl > 0 ? new Date(Date.now() + ttl * 1000) : null;

  /*
   * Les mentions sont résolues AVANT la création, et écrites AVEC elle.
   *
   * ⚠️ EN UNE SEULE ÉCRITURE (`mentions: { create: … }`) et non par un second
   * appel : un message créé puis une insertion qui échoue laisserait une
   * mention perdue — un « @Dominique » à l'écran qui ne notifierait personne,
   * sans que rien ne le signale.
   */
  const mentions = await mentionsRetenues({
    convId,
    expediteurId,
    demandees: params.mentions ?? [],
  });

  const message = await creerLigneMessage({
    convId,
    senderId: expediteurId,
    content,
    type,
    replyToId,
    status: "SENT",
    expiresAt,
    ...(idsMedias.length > 0 ? { media: { connect: idsMedias.map((id) => ({ id })) } } : {}),
    ...(mentions.length > 0 ? { mentions: { create: mentions } } : {}),
    /*
     * LA MENTION COLLECTIVE — jumeau exact de `ws-server.mjs`.
     *
     * Un booléen, et non une ligne par membre : une liste figée à l'envoi serait
     * fausse dès le lendemain, quand quelqu'un rejoint le groupe et n'y figure
     * pas alors que le message dit « tout le monde ».
     *
     * Refusée hors groupe, comme les mentions nominatives : le serveur ne fait
     * jamais confiance à ce que le client lui envoie.
     */
    mentionneTous,
    mentionTousLibelle: mentionneTous ? (params.mentionTousLibelle ?? "").trim().slice(0, 80) : null,
  });

  /*
   * L'INSTANTANÉ DU STATUT CITÉ.
   *
   * Écrit APRÈS le message, puisqu'il porte sa clé. Un échec ici laisse un
   * message ordinaire — sans aperçu, mais remis — plutôt que pas de message du
   * tout : c'est le bon compromis pour une décoration.
   *
   * ⚠️ RECOPIÉ, JAMAIS RÉFÉRENCÉ : le statut est purgé au bout de 24 h, et une
   * citation qui pointerait vers lui disparaîtrait avec.
   */
  if (params.statutCite) {
    try {
      const statut = await prisma.status.findUnique({
        where: { id: params.statutCite },
        select: { id: true, userId: true, type: true, text: true, mediaUrl: true, bgColor: true },
      });
      // On ne cite que ce qu'on avait le droit de voir — sinon la citation
      // deviendrait une porte dérobée sur un statut privé.
      if (statut && (await peutVoirStatutsDe(expediteurId, statut.userId))) {
        await prisma.statusReplyQuote.create({
          data: {
            messageId: message.id,
            statusId: statut.id,
            authorId: statut.userId,
            type: statut.type,
            text: statut.text,
            mediaUrl: statut.mediaUrl,
            bgColor: statut.bgColor,
          },
        });
      }
    } catch (e) {
      console.error("[messages] citation de statut ignorée :", e);
    }
  }

  /*
   * `lastMessage` reçoit le LIBELLÉ, jamais la charge utile.
   *
   * Un CONTACT ou une LOCATION porte du JSON dans `content` ; l'y recopier
   * afficherait `{"v":1,…}` sous le nom du correspondant. Et `apercuStructure`
   * seul laissait la colonne à NULL pour un média sans légende, ce qui faisait
   * basculer la liste sur l'aperçu du dernier APPEL (défaut mesuré en
   * production le 18/08/2026). `apercuMessage` couvre les deux cas.
   */
  await prisma.conversation.update({
    where: { id: convId },
    data: {
      lastMessage: apercuMessage(type, content)?.slice(0, 500) ?? null,
      lastMessageAt: new Date(),
      lastMessageSenderID: expediteurId,
      lastMessageType:
        type === "TEXT" ? 0 : type === "IMAGE" ? 1 : type === "AUDIO" ? 3 : type === "VIDEO" ? 4 : 2,
      lastMessageStatus: 0,
    },
  });

  await prisma.participant.updateMany({
    where: { convId, userId: { not: expediteurId } },
    data: { unreadCount: { increment: 1 } },
  });

  return { ok: true, message };
}

/** Sérialisation d'un message et de ses médias, commune aux deux routes. */
export function serialiserMessage(message: Awaited<ReturnType<typeof creerLigneMessage>>) {
  return {
    id: message.id,
    convId: message.convId,
    senderId: message.senderId,
    content: message.content,
    type: message.type,
    status: message.status,
    replyToId: message.replyToId,
    media: message.media.map((f) => ({
      id: f.id,
      // L'URL de lecture reste proxyfiée par le backend : c'est elle qui porte
      // le contrôle d'accès, quel que soit le stockage derrière.
      url: `/api/media/${f.id}`,
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      durationMs: f.durationMs,
    })),
    /*
     * LES MENTIONS ACCOMPAGNENT LE MESSAGE, jamais son texte.
     *
     * Le client met en évidence `@libelle` dans la bulle et sait, pour chaque
     * mention, QUEL compte est visé — ce que le texte seul ne dit pas. Un
     * client plus ancien ignore le champ et affiche une phrase ordinaire :
     * c'est tout l'intérêt d'avoir laissé le texte en clair.
     */
    mentions: (message.mentions ?? []).map((m) => ({
      userId: m.userId,
      libelle: m.libelle,
    })),
    createdAt: message.createdAt,
  };
}
