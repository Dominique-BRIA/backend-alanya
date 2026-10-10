import { type NextRequest } from "next/server";
import { previensDesPersonnes } from "@/lib/salle-temps-reel";
import { annoncerMessageChiffre } from "@/lib/e2ee-annonce";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import {
  ENVELOPPES_MAX,
  blocageAvec,
  deposerEnveloppes,
  destinataireEtranger,
  lireEnveloppes,
} from "@/modules/e2ee/enveloppes";

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

// Plafonds d'un dépôt (ENVELOPPES_MAX, CORPS_MAX) : `src/modules/e2ee/enveloppes.ts`,
// partagés avec la publication différée d'un envoi en morceaux.

/** Plafond d'une relève, pour borner la réponse. */
const RELEVE_MAX = 200;

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
    where: { convId: r.convId, userId, ...MEMBRE_ACTIF },
    select: { id: true },
  });
  if (!moi) return fail("Conversation inconnue", 404, "NOT_FOUND");

  /*
   * 🔴 ON NE DÉPOSE QUE DANS UN FIL CHIFFRÉ.
   *
   * 🐛 RIEN NE LE VÉRIFIAIT. Dans un fil ordinaire, une enveloppe rattachée à
   * un message EN CLAIR faisait marquer ce message `chiffre: true` à la
   * lecture — un cadenas affiché sur un texte que le serveur lit. Et le dépôt
   * sonne et notifie : une porte de plus pour déranger quelqu'un. Le fil
   * n'est chiffré qu'après la route `/e2ee`, qui vérifie le périmètre ; le
   * dépôt s'appuie donc sur elle. Prouvé par `scripts/e2ee-depot-banc.mjs` ②.
   */
  const fil = await prisma.conversation.findUnique({
    where: { id: r.convId },
    select: { e2eeActif: true, isGroup: true },
  });
  if (fil?.e2eeActif !== true) {
    return fail("Cette conversation n'est pas chiffrée", 409, "CONVERSATION_NON_CHIFFREE");
  }
  const enGroupe = fil.isGroup === true;

  /*
   * ⚠️ LE MESSAGE DOIT APPARTENIR À CETTE CONVERSATION, et le vérifier n'est
   * pas du zèle : sans ce contrôle, on rattacherait le contenu chiffré d'un
   * fil au message d'un AUTRE. Le destinataire verrait alors apparaître, dans
   * une conversation, un texte écrit pour une autre — une fuite que le
   * chiffrement lui-même ne peut pas empêcher, puisqu'elle a lieu APRÈS le
   * déchiffrement, chez quelqu'un qui a bien le droit de lire.
   */
  let messageId: string | null = null;
  /*
   * 🔴 EN GROUPE, AUCUNE ENVELOPPE NE PORTE UN MESSAGE. Le message de groupe a
   * son propre chiffré, écrit avec sa ligne (`e2ee_messages_groupe`). Les
   * enveloppes d'un groupe ne transportent que le TROUSSEAU, hors fil. Une
   * enveloppe rattachée à un message ferait sonner et notifier trois cents
   * personnes pour un contenu qui ne leur est pas destiné.
   */
  if (enGroupe && typeof r.messageId === "string" && r.messageId !== "") {
    return fail("En groupe, les enveloppes ne portent que le trousseau", 400, "BAD_BODY");
  }
  if (typeof r.messageId === "string" && r.messageId !== "") {
    const ligne = await prisma.message.findFirst({
      where: { id: r.messageId, convId: r.convId, senderId: userId },
      select: { id: true },
    });
    if (!ligne) return fail("Message inconnu", 404, "NOT_FOUND");
    messageId = ligne.id;
  }

  // Forme et taille : `lireEnveloppes`, la même règle que la publication différée.
  const lues = lireEnveloppes(r.enveloppes);
  if (lues === "AUCUNE") return fail("Aucune enveloppe", 400, "BAD_BODY");
  if (lues === "TROP") {
    return fail(`Pas plus de ${ENVELOPPES_MAX} enveloppes par envoi`, 400, "TOO_MANY");
  }
  if (lues === "MAL_FORMEE") {
    return fail("Une enveloppe est mal formée", 400, "BAD_BODY");
  }

  // Les destinataires doivent être de la conversation : sans ce contrôle, on
  // s'en servirait pour déposer chez n'importe qui.
  if (await destinataireEtranger(r.convId, lues)) {
    return fail("Destinataire hors de la conversation", 403, "FORBIDDEN");
  }

  /*
   * 🔴 UN BLOCAGE ARRÊTE AUSSI LE CHIFFRÉ, dans les deux sens — même règle que
   * `creerMessage` et que le WebSocket.
   *
   * 🐛 LE DÉPÔT NE LE REGARDAIT PAS. La ligne du message était bien refusée
   * ailleurs… mais le dépôt, lui, acceptait sans ligne, puis sonnait et
   * notifiait : une personne bloquée faisait vibrer, en boucle, le téléphone de
   * celle qui l'avait bloquée. Prouvé par `scripts/e2ee-depot-banc.mjs` ③.
   */
  /*
   * ⚠️ SAUF EN GROUPE (09/10/2026). Un blocage entre deux membres ne retire la
   * parole à personne dans un groupe (`creerMessage`) ; il ne doit pas non
   * plus priver quelqu'un du TROUSSEAU, sans lequel il ne lirait plus rien du
   * groupe. Et un dépôt de groupe ne sonne ni ne notifie (hors fil, voir
   * ci-dessus) : il ne peut pas servir à harceler.
   */
  if (!enGroupe && (await blocageAvec(userId, lues))) {
    return fail("Message non distribuable", 403, "BLOCKED");
  }

  await deposerEnveloppes({
    convId: r.convId,
    expediteurId: userId,
    expediteurDevice: r.deviceId,
    messageId,
    lues,
  });

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
  /*
   * ⚠️ SANS LIGNE DE MESSAGE, NI SONNETTE NI NOTIFICATION. Un dépôt sans
   * `messageId` reste permis (bancs, futur échange de clés hors fil), mais il
   * n'annonce rien à personne : sonner pour rien, c'était la moitié du
   * harcèlement possible par cette route. Prouvé par `e2ee-depot-banc.mjs` ④.
   */
  /*
   * 🔴 SAUF UN TROUSSEAU DE GROUPE (lot 7, 10/10/2026) : sans sonnette, un
   * membre qui attend sa clé ne voyait rien changer avant de rouvrir le fil.
   * On prévient donc ses appareils qu'une clé l'attend — `e2ee_trousseau`,
   * des identifiants seulement, et SANS notification poussée : on ne fait
   * pas vibrer un téléphone pour une clé.
   */
  if (messageId === null && enGroupe) {
    await previensDesPersonnes({
      personnes: [...new Set(lues.map((e) => e!.destinataireId))],
      type: "e2ee_trousseau",
      donnees: { convId: r.convId as string },
    });
  }
  if (messageId === null) return ok({ deposees: lues.length }, 201);

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
   * 🐛 CE BLOC EXISTAIT EN DOUBLE (commit 445266e) : un premier, à import
   * statique, juste avant la sonnette, et celui-ci. Chaque message chiffré
   * notifiait donc DEUX FOIS chaque destinataire. Retiré le 28/09/2026 — par
   * lecture : l'envoi push est inerte en local, on n'a pas pu compter les
   * notifications, seulement voir les deux appels. UN seul appel par dépôt.
   *
   * ⚠️ ON NE SE NOTIFIE PAS SOI-MÊME, contrairement à la sonnette. Une relève
   * de trop ne coûte qu'un aller-retour ; une notification de trop s'affiche à
   * l'écran de celui qui vient d'écrire. Ses autres appareils la perdent —
   * c'est le prix, et il est bien plus faible que l'inverse.
   */
  /*
   * ⚠️ LA SOURDINE VAUT AUSSI ICI. Le WebSocket la respecte pour les messages
   * ordinaires ; le dépôt l'ignorait, et un fil chiffré mis en sourdine
   * sonnait quand même. Même règle : elle coupe la notification, jamais la
   * sonnette temps réel (on reste à jour dans un fil qu'on regarde).
   */
  // Le code vit dans `@/lib/e2ee-annonce` depuis le 09/10/2026 : le message de
  // GROUPE chiffré en a besoin aussi. Les leçons ci-dessus y restent valables.
  await annoncerMessageChiffre({
    convId: r.convId as string,
    expediteurId: userId,
    messageId,
    personnes: lues.map((e) => e!.destinataireId),
  });

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
  const cible = { id: { in: ids }, destinataireId: userId, remisLe: null };
  const acquittees = await prisma.e2eeEnveloppe.findMany({
    where: cible,
    select: { messageId: true },
  });
  const { count } = await prisma.e2eeEnveloppe.updateMany({
    where: cible,
    data: { remisLe: new Date() },
  });

  /*
   * 🔴 « DISTRIBUÉ » : UN APPAREIL DU DESTINATAIRE A REÇU LE MESSAGE.
   *
   * 🐛 UN MESSAGE CHIFFRÉ NE PASSAIT JAMAIS À « DISTRIBUÉ » (user, 28/09/2026).
   * Pour un message ordinaire, `handleSend` le fait au moment de l'envoi si le
   * destinataire est en ligne. Un message chiffré, lui, est créé par la route
   * REST, qui ne le fait pas : il restait « envoyé » jusqu'à la lecture.
   *
   * ⚠️ L'ACQUITTEMENT EST LE BON MOMENT, pas le dépôt : c'est la preuve qu'un
   * appareil du destinataire a relevé l'enveloppe. Déposer ne prouve rien —
   * le destinataire peut être hors ligne pendant des jours.
   *
   * ⚠️ `SENT` SEULEMENT : un message déjà « lu » ne redescend pas. Et jamais
   * nos propres messages — ce sont les copies vers nos autres appareils.
   */
  const messageIds = [
    ...new Set(acquittees.map((e) => e.messageId).filter((id): id is string => !!id)),
  ];
  if (messageIds.length > 0) {
    const aPasser = await prisma.message.findMany({
      where: { id: { in: messageIds }, status: "SENT", senderId: { not: userId } },
      select: { id: true, convId: true, senderId: true },
    });
    if (aPasser.length > 0) {
      await prisma.message.updateMany({
        where: { id: { in: aPasser.map((m) => m.id) }, status: "SENT" },
        data: { status: "DELIVERED" },
      });
      /*
       * ⚠️ LE PONT N'ACCEPTE QUE LES VERBES `e2ee_*` : d'où `e2ee_distribue`
       * et non `message_status`. Les clients le traitent comme ce dernier.
       * Un échec du pont ne fait pas échouer l'acquittement.
       */
      for (const m of aPasser) {
        await previensDesPersonnes({
          personnes: [m.senderId],
          type: "e2ee_distribue",
          donnees: { convId: m.convId, messageId: m.id, status: "DELIVERED" },
        });
      }
    }
  }

  return ok({ acquittees: count });
});
