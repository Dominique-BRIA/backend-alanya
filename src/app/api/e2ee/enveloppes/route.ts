import { type NextRequest } from "next/server";
import { pushNewMessage } from "@/../push.mjs";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * LES ENVELOPPES CHIFFRÉES — le transport, et rien d'autre.
 *
 * `POST   /api/e2ee/enveloppes` → déposer les chiffrés d'un message
 * `GET    /api/e2ee/enveloppes?deviceId=N` → relever ce qui m'attend
 * `DELETE /api/e2ee/enveloppes?ids=a,b,c` → accuser réception
 *
 * 🔴 LE SERVEUR NE LIT RIEN, ET NE PEUT RIEN LIRE. `corps` est une chaîne
 * opaque. Aucune route de ce fichier ne l'inspecte, ne le transforme, ni ne le
 * journalise — et c'est une règle, pas une économie : un journal qui recopie
 * un chiffré ne révèle rien aujourd'hui, mais fait exister un second endroit à
 * protéger, que personne ne surveille.
 *
 * ⚠️ UNE ENVELOPPE PAR APPAREIL DESTINATAIRE. C'est l'expéditeur qui chiffre
 * autant de fois qu'il y a d'appareils, après avoir récupéré un paquet de
 * pré-clés pour chacun. Le serveur ne duplique JAMAIS une enveloppe : il n'en
 * aurait pas les moyens, chaque chiffré étant lié à une session distincte.
 */

/** Plafond d'un dépôt : quelques appareils, pas une diffusion. */
const ENVELOPPES_MAX = 40;

/** Plafond d'une relève, pour borner la réponse. */
const RELEVE_MAX = 200;

/** Taille maximale d'un chiffré, en caractères base64 (~48 Ko utiles). */
const CORPS_MAX = 64 * 1024;

export const POST = withAuth(async (req: NextRequest, userId: string) => {
  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const r = (corps ?? {}) as {
    convId?: unknown;
    deviceId?: unknown;
    enveloppes?: unknown;
    messageId?: unknown;
  };

  if (typeof r.convId !== "string" || r.convId === "") {
    return fail("« convId » est requis", 400, "BAD_BODY");
  }
  if (typeof r.deviceId !== "number" || !Number.isInteger(r.deviceId)) {
    return fail("« deviceId » de l'expéditeur est requis", 400, "BAD_BODY");
  }

  /*
   * ⚠️ L'APPARTENANCE À LA CONVERSATION EST VÉRIFIÉE ICI, et c'est le seul
   * contrôle que le serveur puisse encore exercer. Il ne sait plus ce qui est
   * écrit ; il sait encore QUI a le droit d'écrire à QUI, et cette garde-là ne
   * doit pas disparaître avec le chiffrement.
   */
  const moi = await prisma.participant.findFirst({
    where: { convId: r.convId, userId },
    select: { id: true },
  });
  if (!moi) return fail("Conversation inconnue", 404, "NOT_FOUND");

  /*
   * ⚠️ LE MESSAGE DOIT APPARTENIR À CETTE CONVERSATION, et le vérifier n'est
   * pas du zèle : sans ce contrôle, on rattacherait le contenu chiffré d'un
   * fil au message d'un AUTRE. Le destinataire verrait alors apparaître, dans
   * une conversation, un texte écrit pour une autre — une fuite que le
   * chiffrement lui-même ne peut pas empêcher, puisqu'elle a lieu APRÈS le
   * déchiffrement, chez quelqu'un qui a bien le droit de lire.
   */
  let messageId: string | null = null;
  if (typeof r.messageId === "string" && r.messageId !== "") {
    const ligne = await prisma.message.findFirst({
      where: { id: r.messageId, convId: r.convId, senderId: userId },
      select: { id: true },
    });
    if (!ligne) return fail("Message inconnu", 404, "NOT_FOUND");
    messageId = ligne.id;
  }

  const brutes = Array.isArray(r.enveloppes) ? r.enveloppes : [];
  if (brutes.length === 0) return fail("Aucune enveloppe", 400, "BAD_BODY");
  if (brutes.length > ENVELOPPES_MAX) {
    return fail(`Pas plus de ${ENVELOPPES_MAX} enveloppes par envoi`, 400, "TOO_MANY");
  }

  const lues = brutes.map((b) => {
    const e = (b ?? {}) as Record<string, unknown>;
    const ok =
      typeof e.destinataireId === "string" &&
      e.destinataireId !== "" &&
      typeof e.destinataireDevice === "number" &&
      Number.isInteger(e.destinataireDevice) &&
      // 3 = PreKeyWhisperMessage (ouvre la session), 1 = WhisperMessage. Les deux seules valeurs
      // que la bibliothèque du client sait produire et relire.
      (e.type === 1 || e.type === 3) &&
      typeof e.corps === "string" &&
      e.corps.length > 0 &&
      e.corps.length <= CORPS_MAX;
    return ok
      ? {
          destinataireId: e.destinataireId as string,
          destinataireDevice: e.destinataireDevice as number,
          type: e.type as number,
          corps: e.corps as string,
        }
      : null;
  });
  if (lues.some((e) => e === null)) {
    return fail("Une enveloppe est mal formée", 400, "BAD_BODY");
  }

  // Les destinataires doivent être de la conversation : sans ce contrôle, on
  // s'en servirait pour déposer chez n'importe qui.
  const membres = await prisma.participant.findMany({
    where: { convId: r.convId },
    select: { userId: true },
  });
  const autorises = new Set(membres.map((m) => m.userId));
  if (lues.some((e) => !autorises.has(e!.destinataireId))) {
    return fail("Destinataire hors de la conversation", 403, "FORBIDDEN");
  }

  await prisma.e2eeEnveloppe.createMany({
    data: lues.map((e) => ({
      convId: r.convId as string,
      expediteurId: userId,
      expediteurDevice: r.deviceId as number,
      destinataireId: e!.destinataireId,
      destinataireDevice: e!.destinataireDevice,
      type: e!.type,
      corps: e!.corps,
      messageId,
    })),
  });

  /*
   * ══════════════ LA NOTIFICATION POUSSEE ══════════════
   *
   * 🐛 UN MESSAGE CHIFFRE NE NOTIFIAIT PERSONNE. `pushNewMessage` n'est appele
   * que depuis `ws-server.mjs`, et les messages chiffres partent en REST : un
   * destinataire application fermee ne recevait RIEN. Jamais.
   *
   * ⚠️ MEME ENDROIT QUE LA SONNETTE, ET MEME RAISON : c'est le depot qui rend
   * le message lisible. Notifier a la creation de la ligne reveillerait
   * quelqu'un pour un message dont le texte n'est pas encore arrive.
   *
   * 🔴 AUCUN APERCU, JAMAIS. `preview` reste nul et le type est force a TEXT :
   * le serveur ne connait pas ce texte, et s'il le connaissait il ne devrait
   * pas le mettre dans une notification — qui s'affiche sur un ecran
   * verrouille, transite par Google, et se journalise en chemin.
   *
   * ⚠️ LE NOM DE L'EXPEDITEUR, LUI, EST DEJA CONNU du destinataire comme du
   * serveur. Le taire n'apporterait rien et rendrait la notification inutile.
   *
   * ⚠️ ON NE SE NOTIFIE PAS SOI-MEME : l'expediteur est souvent son propre
   * destinataire, pour ses autres appareils.
   */
  const aPrevenir = [...new Set(lues.map((e) => e!.destinataireId))].filter(
    (id) => id !== userId,
  );
  if (aPrevenir.length > 0) {
    const expediteur = await prisma.user.findUnique({
      where: { id: userId },
      select: { nom: true },
    });
    for (const destinataire of aPrevenir) {
      // ⚠️ NE DOIT PAS FAIRE ECHOUER LE DEPOT : le message est ecrit et valide.
      // Une notification perdue coute une remise differee, pas un message.
      await pushNewMessage(prisma, {
        recipientId: destinataire,
        senderName: expediteur?.nom ?? "",
        senderId: userId,
        convId: r.convId as string,
        convTitle: null,
        preview: null,
        messageType: "TEXT",
      }).catch(() => undefined);
    }
  }
  /*
   * ══════════════ LA SONNETTE, ET ELLE EST ICI POUR UNE RAISON ══════════════
   *
   * 🐛 « LE MESSAGE N'ARRIVE PAS INSTANTANEMENT » — constate par le user le
   * 21/09/2026 : Alice ecrit, rien ne bouge chez Bob ; Bob ecrit a son tour, et
   * c'est SEULEMENT LA que le message d'Alice apparait.
   *
   * LA CAUSE. Un message ordinaire part par le WebSocket, qui l'ecrit ET le
   * diffuse dans la foulee. Un message chiffre, lui, part en REST — et la route
   * REST ne diffuse RIEN, volontairement (voir `creerMessage`). Personne ne
   * prevenait donc le destinataire. Il ne decouvrait le message qu'au prochain
   * rafraichissement de son fil, c'est-a-dire quand il ecrivait lui-meme.
   *
   * 🔴 POURQUOI LA SONNETTE EST DANS LE DEPOT ET NON DANS LA CREATION DU
   * MESSAGE. Un message chiffre s'ecrit en DEUX temps : la ligne du fil, puis
   * les enveloppes qui portent le texte. Sonner apres la premiere etape
   * enverrait le destinataire relever un fil ou RIEN ne l'attend encore — et il
   * ne serait pas rappele. C'est le depot, et lui seul, qui rend le message
   * lisible : c'est donc de lui que part l'avis.
   *
   * ⚠️ ON NE SONNE PAS CHEZ SOI. L'expediteur est souvent son propre
   * destinataire — ses autres appareils. Mais celui qui vient d'ecrire a deja
   * son texte a l'ecran : le renvoyer relever lui ferait un aller-retour pour
   * rien. Ses AUTRES appareils, eux, sont bien prevenus : ils sont dans la
   * liste, c'est le compte qui est exclu... et c'est justement ce qu'on ne
   * peut pas distinguer ici — la trame vise un COMPTE, pas un appareil. On
   * accepte donc l'aller-retour de trop plutot que de priver un second
   * appareil de sa remise immediate.
   *
   * ⚠️ ELLE NE PEUT PAS FAIRE ECHOUER LE DEPOT. `previensDesPersonnes` ne leve
   * jamais et rend `false` quand le pont est absent : le message est ecrit, il
   * est valide, et au pire il arrivera a la prochaine ouverture.
   */
  await previensDesPersonnes({
    personnes: [...new Set(lues.map((e) => e!.destinataireId))],
    type: "e2ee_arrivee",
    donnees: { convId: r.convId as string, messageId },
  });

  /*
   * ══════════════ LA NOTIFICATION POUSSÉE ══════════════
   *
   * 🐛 UN MESSAGE CHIFFRÉ NE NOTIFIAIT PERSONNE. `pushNewMessage` n'est appelé
   * que depuis `ws-server.mjs` ; les messages chiffrés partent en REST, qui ne
   * notifie personne — et c'est documenté comme voulu dans `creerMessage`.
   * Application fermée, RIEN n'arrivait. Jamais.
   *
   * 🔴 LE CORPS EST GÉNÉRIQUE, ET IL DOIT LE RESTER. Le serveur ne connaît pas
   * le texte — c'est le principe — donc aucun aperçu n'est possible, et c'est
   * tant mieux : une notification traverse les serveurs de Google ou d'Apple et
   * s'affiche sur un écran verrouillé. Le jour où quelqu'un voudra « améliorer
   * l'aperçu » ici, la réponse est non.
   *
   * ⚠️ MÊME ENDROIT QUE LA SONNETTE, ET POUR LA MÊME RAISON : après le dépôt.
   * Notifier à la création de la ligne enverrait le destinataire ouvrir un
   * message dont le contenu n'existe pas encore.
   *
   * ⚠️ ON NE SE NOTIFIE PAS SOI-MÊME, contrairement à la sonnette. Une relève
   * de trop ne coûte qu'un aller-retour ; une notification de trop s'affiche à
   * l'écran de celui qui vient d'écrire. Ses autres appareils la perdent —
   * c'est le prix, et il est bien plus faible que l'inverse.
   */
  const aNotifier = [...new Set(lues.map((e) => e!.destinataireId))].filter(
    (id) => id !== userId,
  );
  if (aNotifier.length > 0) {
    try {
      const [{ pushNewMessage }, expediteur] = await Promise.all([
        import("@/../push.mjs"),
        prisma.user.findUnique({ where: { id: userId }, select: { nom: true } }),
      ]);
      await Promise.all(
        aNotifier.map((destinataireId) =>
          pushNewMessage(prisma, {
            recipientId: destinataireId,
            senderName: expediteur?.nom ?? "",
            senderId: userId,
            convId: r.convId as string,
            convTitle: null,
            // ⚠️ NUL, ET C'EST LE POINT. `pushNewMessage` retombe alors sur
            // « Nouveau message » — le seul texte honnête ici.
            preview: null,
            messageType: "TEXT",
          }),
        ),
      );
    } catch (e) {
      /*
       * ⚠️ NE FAIT JAMAIS ÉCHOUER LE DÉPÔT. Le message est écrit et valide ;
       * au pire il arrivera à la prochaine ouverture. Faire tomber l'envoi
       * parce que Firebase tousse serait échanger un défaut d'affichage
       * contre une perte de message.
       */
      console.error("[e2ee] notification impossible :", e);
    }
  }

  return ok({ deposees: lues.length }, 201);
});

export const GET = withAuth(async (req: NextRequest, userId: string) => {
  const brut = req.nextUrl.searchParams.get("deviceId");
  const deviceId = Number(brut);
  if (brut === null || !Number.isInteger(deviceId)) {
    return fail("« deviceId » est requis", 400, "BAD_BODY");
  }

  /*
   * ⚠️ ON NE MARQUE PAS « REMIS » ICI. Le client peut perdre la réponse, ou
   * planter en plein déchiffrement ; marquer à l'envoi perdrait le message
   * définitivement, puisque personne d'autre ne l'a. C'est l'accusé de
   * réception explicite (`DELETE`) qui retire — le client garde donc la
   * responsabilité de dire qu'il a bien rangé ce qu'il a lu.
   */
  /*
   * 🔴 LA RELÈVE PROUVE QUE CET APPAREIL EXISTE ENCORE.
   *
   * C'est le seul signe de vie fiable : un appareil peut publier ses clés
   * puis disparaître à jamais, mais il ne peut pas RELEVER sans exister. On
   * horodate donc ici, et nulle part ailleurs.
   *
   * ⚠️ SANS CE REPÈRE, RIEN NE DISTINGUE UNE IDENTITÉ VIVANTE D'UNE MORTE, et
   * les correspondants continuent de chiffrer pour des appareils qui ne
   * liront jamais — un message en six exemplaires dont cinq sont perdus.
   *
   * ⚠️ `updateMany` ET NON `update` : l'identité peut ne pas exister (un
   * client qui relève avant d'avoir publié ses clés). On ne veut pas lever
   * pour si peu, et `updateMany` sur zéro ligne ne se plaint pas.
   */
  await prisma.e2eeIdentite.updateMany({
    where: { userId, deviceId },
    data: { derniereReleve: new Date() },
  });

  const enveloppes = await prisma.e2eeEnveloppe.findMany({
    where: { destinataireId: userId, destinataireDevice: deviceId, remisLe: null },
    orderBy: { createdAt: "asc" },
    take: RELEVE_MAX,
    select: {
      id: true,
      convId: true,
      expediteurId: true,
      expediteurDevice: true,
      messageId: true,
      type: true,
      corps: true,
      createdAt: true,
    },
  });

  return ok({ enveloppes });
});

export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  const brut = req.nextUrl.searchParams.get("ids");
  if (!brut) return fail("« ids » est requis", 400, "BAD_BODY");

  const ids = brut.split(",").map((s) => s.trim()).filter(Boolean).slice(0, RELEVE_MAX);
  if (ids.length === 0) return fail("Aucun identifiant", 400, "BAD_BODY");

  /*
   * ⚠️ LE DESTINATAIRE EST DANS LA CONDITION, jamais seulement l'identifiant :
   * sans lui, un identifiant qui fuite suffirait à faire disparaître le message
   * de quelqu'un d'autre avant qu'il ne l'ait lu.
   */
  const { count } = await prisma.e2eeEnveloppe.updateMany({
    where: { id: { in: ids }, destinataireId: userId, remisLe: null },
    data: { remisLe: new Date() },
  });

  return ok({ acquittees: count });
});
