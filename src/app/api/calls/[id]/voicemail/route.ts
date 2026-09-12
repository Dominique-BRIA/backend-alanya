import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { accueilPourAppelant } from "@/lib/repondeur.mjs";
import { creerMessage } from "@/modules/messaging/envoi";
import { pushNewMessage } from "@/../push.mjs";
import { findOrCreateDirectConversation } from "@/modules/messaging/access";
import { nomAffichage } from "@/lib/display-name.mjs";

/**
 * POST /api/calls/:id/voicemail — dépose la messagerie vocale laissée après un
 * appel sans réponse.
 *
 * Corps : `{ "mediaId": "<uuid>" }`.
 *
 * 🔴 C'EST L'APPELANT QUI TÉLÉVERSE, ET C'EST TOUT LE DANGER DE CETTE ROUTE.
 *
 * Le répondeur est joué par le client de l'appelant — les appels étant en
 * pair-à-pair, personne ne décroche donc aucun pair n'existe pour enregistrer.
 * La conséquence est qu'un client modifié pourrait, sans ces contrôles, déposer
 * un message vocal chez n'importe qui sans jamais avoir appelé : un canal de
 * démarchage vocal ouvert à tous, contournant le blocage et le répertoire.
 *
 * Les cinq vérifications ci-dessous sont donc la fonctionnalité elle-même,
 * pas une précaution.
 */

/**
 * Au-delà, l'appel n'ouvre plus de droit à déposer.
 *
 * ⚠️ SANS CETTE BORNE, UN IDENTIFIANT D'APPEL SERAIT UN LAISSEZ-PASSER
 * PERMANENT : celui d'un appel manqué l'an dernier permettrait encore de
 * déposer un message aujourd'hui. Dix minutes couvrent largement le temps
 * d'écouter un accueil, d'enregistrer et de téléverser, même sur un réseau lent.
 */
const FENETRE_DEPOT_MS = 10 * 60 * 1000;

export const POST = withAuth(async (req: NextRequest, userId: string, ctx) => {
  const { id: callId } = await ctx.params;

  let corps: unknown;
  try {
    corps = await req.json();
  } catch {
    return fail("Corps JSON invalide", 400, "BAD_JSON");
  }
  const mediaId = (corps as { mediaId?: unknown } | null)?.mediaId;
  if (typeof mediaId !== "string" || mediaId.trim() === "") {
    return fail("« mediaId » est requis", 400, "BAD_BODY");
  }

  const appel = await prisma.call.findUnique({
    where: { id: callId },
    select: {
      id: true,
      convId: true,
      initiatorId: true,
      answeredAt: true,
      startedAt: true,
      participants: { select: { userId: true } },
      messagerieVocale: { select: { id: true } },
    },
  });

  // ── 1. L'appel existe, et je l'ai initié ────────────────────────────────
  //
  // Le déposant DOIT être l'appelant : c'est lui qui a entendu l'accueil et
  // parlé. Un participant quelconque n'aurait rien à déposer.
  if (!appel || appel.initiatorId !== userId) {
    return fail("Appel introuvable", 404, "NOT_FOUND");
  }

  // ── 2. Il n'a pas été décroché ──────────────────────────────────────────
  //
  // Un appel abouti n'a pas de répondeur : les deux se sont parlé.
  if (appel.answeredAt !== null) {
    return fail("Cet appel a été décroché", 409, "CALL_ANSWERED");
  }

  // ── 3. Il est récent ────────────────────────────────────────────────────
  if (Date.now() - appel.startedAt.getTime() > FENETRE_DEPOT_MS) {
    return fail("Cet appel est trop ancien", 409, "CALL_TOO_OLD");
  }

  // ── 4. Il n'a pas déjà sa messagerie ────────────────────────────────────
  //
  // L'index unique partiel le garantit aussi en base ; ce contrôle-ci rend un
  // refus lisible plutôt qu'une violation de contrainte.
  if (appel.messagerieVocale.length > 0) {
    return fail("Cet appel a déjà une messagerie vocale", 409, "ALREADY_LEFT");
  }

  // ── 5. Le destinataire est unique, et son répondeur est actif ───────────
  //
  // ⚠️ UN APPEL DE GROUPE N'A PAS DE RÉPONDEUR : à qui appartiendrait le
  // message ? On refuse plutôt que de choisir arbitrairement.
  const destinataires = appel.participants
    .map((p) => p.userId)
    .filter((id) => id !== userId);
  if (destinataires.length !== 1) {
    return fail("Pas de répondeur pour un appel de groupe", 409, "GROUP_CALL");
  }
  const destinataireId = destinataires[0];

  /*
   * 🔴 LA MÊME RÈGLE QUE CELLE QUI A JOUÉ L'ACCUEIL, et pas une deuxième.
   *
   * Ce contrôle lisait `repondeurActif` tout seul, là où `accueilPourAppelant`
   * regarde AUSSI l'absence en cours. Les deux pouvaient donc se contredire :
   * quelqu'un qui éteint l'interrupteur pendant une absence faisait entendre son
   * accueil — l'absence l'emporte — mais le dépôt du message était refusé juste
   * après. L'appelant parlait deux minutes pour s'entendre dire non.
   *
   * Une seule question, posée au même endroit : « cette personne a-t-elle un
   * accueil à faire entendre ? » Si oui, elle peut recevoir le message.
   */
  const repondeur = await accueilPourAppelant(prisma, destinataireId);
  if (!repondeur) {
    return fail("Le répondeur n'est pas actif", 409, "NO_ANSWERING_MACHINE");
  }

  // Le média doit m'appartenir : sans ce contrôle, on déposerait le fichier de
  // quelqu'un d'autre, y compris un média reçu dans une autre conversation.
  const media = await prisma.mediaFile.findUnique({
    where: { id: mediaId },
    select: { ownerId: true, mimeType: true },
  });
  if (!media || media.ownerId !== userId) {
    return fail("Média introuvable", 404, "NOT_FOUND");
  }
  if (!media.mimeType.startsWith("audio/") && !media.mimeType.startsWith("video/")) {
    return fail("La messagerie vocale doit être un fichier audio", 400, "BAD_MEDIA");
  }

  /*
   * 🐛 LE TYPE ETAIT ECRIT EN DUR : « AUDIO », quoi qu'on ait deposé.
   *
   * Un appel vidéo sans réponse laisse une messagerie VIDÉO — on avait appelé
   * en vidéo, et répondre par la voix seule perdrait ce qu'on voulait montrer.
   * Le média passait donc le contrôle juste au-dessus, puis se voyait étiqueter
   * comme un son : les clients lui donnaient un lecteur audio, et l'image ne
   * s'affichait nulle part alors que le fichier la contenait bel et bien.
   *
   * ⚠️ C'EST LE TYPE MIME QUI TRANCHE, et non ce que le client a annoncé : lui
   * seul décrit le fichier réellement stocké.
   */
  const estVideo = media.mimeType.startsWith("video/");

  /*
   * LA CONVERSATION D'ACCUEIL.
   *
   * ⚠️ `convId` PEUT ÊTRE NUL : un appel lancé depuis le clavier, sans
   * conversation préexistante, n'en porte pas. On la crée alors — c'est
   * exactement ce que fait l'application quand on écrit à quelqu'un pour la
   * première fois, et le message vocal doit atterrir quelque part.
   */
  let convId = appel.convId;
  if (!convId) {
    const conv = await findOrCreateDirectConversation(userId, destinataireId);
    convId = conv.id;
  }

  const resultat = await creerMessage({
    convId,
    expediteurId: userId,
    type: estVideo ? "VIDEO" : "AUDIO",
    mediaId,
    callId: appel.id,
  });
  if (!resultat.ok) {
    // Un blocage entre les deux comptes passe par ici : le refus est légitime
    // et se dit, plutôt que de fabriquer un faux succès.
    return fail("Message refusé", 409, resultat.motif ?? "REFUSED");
  }

  /*
   * LA NOTIFICATION POUSSÉE EST LE SIGNAL DE LIVRAISON.
   *
   * ⚠️ PAS DE DIFFUSION TEMPS RÉEL, ET C'EST LE COMPORTEMENT DE TOUTE
   * L'APPLICATION : un message créé par HTTP n'est pas diffusé — ni par la route
   * des conversations, ni par l'API v1. Le temps réel appartient au WebSocket,
   * que la personne qui dépose ce message n'emprunte pas ici : il lui faut un
   * téléversement et les contrôles ci-dessus.
   *
   * La conséquence, à connaître : un destinataire qui a CETTE conversation
   * ouverte à cet instant précis ne verra sa messagerie qu'au prochain
   * chargement. Il reçoit la notification, ce qui est le signal attendu d'une
   * messagerie vocale ; l'inventer autrement demanderait d'étendre le pont
   * interne, qui ne parle aujourd'hui que des salles de réunion.
   */
  const expediteur = await prisma.user.findUnique({
    where: { id: userId },
    select: { nom: true, pseudo: true, publicNumber: true },
  });
  try {
    await pushNewMessage(prisma, {
      recipientId: destinataireId,
      senderName: (expediteur ? nomAffichage(expediteur) : null) ?? "Quelqu'un",
      convId,
      convTitle: (expediteur ? nomAffichage(expediteur) : null) ?? "Quelqu'un",
      preview: null,
      messageType: estVideo ? "VIDEO" : "AUDIO",
    });
  } catch {
    // Une notification perdue ne perd pas le message : il est enregistré, et
    // apparaîtra à l'ouverture de la conversation.
  }

  return ok({ message: resultat.message }, 201);
});
