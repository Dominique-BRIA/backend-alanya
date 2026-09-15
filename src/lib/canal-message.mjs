/**
 * LE CANAL DE NOTIFICATION ANDROID d'un message, decide COTE SERVEUR.
 *
 * 🔴 POURQUOI LE SERVEUR, ET NON LE CLIENT. Hors de l'application, c'est FCM
 * qui affiche la notification, sans jamais passer par du code Dart : le
 * telephone peut etre verrouille, l'application tuee, son isolate inexistant.
 * Le son ne peut donc PAS etre choisi par le client dans le cas qui compte le
 * plus. Seul le serveur sait, dans les trois etats, a quelle liste appartient
 * l'expediteur et quel son cette liste porte.
 *
 * 🔴 ET POURQUOI UN CANAL, ET NON UN SON. Depuis Android 8 le son d'une
 * notification est porte par son CANAL, et un canal NE PEUT PLUS CHANGER DE SON
 * apres sa creation. Demander un fichier dans la charge FCM n'a aucun effet.
 * La seule facon de faire sonner deux listes differemment est de leur donner
 * deux canaux — c'est ce que fait WhatsApp.
 *
 * ⚠️ MIROIR DE `lib/core/sonneries_livrees.dart` COTE MOBILE. Les identifiants
 * fabriques ici doivent correspondre AU CARACTERE PRES aux canaux que
 * l'application cree a son lancement : un `channelId` inconnu du telephone et
 * Android 8+ n'affiche RIEN DU TOUT. C'est la seule raison pour laquelle cette
 * liste est redoublee ici, et elle doit le rester courte.
 */

/**
 * Les sons de MESSAGE livres avec l'application, et eux seuls.
 *
 * ⚠️ PAS LES SONNERIES D'APPEL. Un appel ne passe pas par un canal de message,
 * et leur donner un canal ici creerait des identifiants que le mobile ne cree
 * pas — donc des notifications invisibles.
 *
 * ⚠️ `notification.mp3` N'EST PAS DE LA LISTE, volontairement : c'est le son du
 * canal historique `messages`. Lui donner un canal dedie aurait produit un
 * second canal jouant exactement le meme son.
 */
const SONS_DE_MESSAGE = new Set([
  "notif-blip.ogg",
  "notif-bloom.ogg",
  "notif-chime.ogg",
  "notif-drop.ogg",
  "notif-duo.ogg",
  "notif-ping.ogg",
  "notif-pop.ogg",
  "notif-tap.ogg",
  "notif-tick.ogg",
  "notif-trio.ogg",
]);

/**
 * Le canal historique, present sur TOUS les telephones ou l'application est
 * installee. C'est le repli, et il ne doit jamais changer de nom : un
 * identifiant neuf ferait repartir a zero les reglages qu'Android garde par
 * canal — volume, vibration, importance.
 */
export const CANAL_MESSAGE_PAR_DEFAUT = "messages";

/**
 * L'identifiant du canal qui joue [fichier], ou le canal par defaut.
 *
 * ⚠️ UNE SONNERIE IMPORTEE RETOMBE TOUJOURS SUR LE DEFAUT. Elle vit derriere
 * `/api/media/<id>`, protegee par un jeton : l'interface systeme d'Android ne
 * saurait pas la lire. Dans la conversation ouverte, en revanche, c'est
 * l'application qui joue le son et elle s'entend bien — la limite ne vaut que
 * pour la notification systeme.
 */
export function canalMessagePour(fichier) {
  if (!fichier || !SONS_DE_MESSAGE.has(fichier)) return CANAL_MESSAGE_PAR_DEFAUT;
  return `msg_${fichier.replace(/-/g, "_").replace(/\.ogg$/, "")}`;
}

/**
 * Le canal a citer pour un message de [senderId] vers [recipientId].
 *
 * La regle d'arbitrage est celle de `ORDRE_LISTES` (`src/lib/contact-lists.ts`)
 * et celle de `SonneriesDeListes.comparePriorite` cote mobile — les trois
 * doivent dire la meme chose, sans quoi un meme correspondant sonnerait
 * differemment selon l'etat de l'application.
 *
 * ⚠️ `nulls: "last"` EST LE POINT DELICAT. `ordre` vaut NULL tant que personne
 * n'a rien ordonne, et un tri ASC met les NULL EN TETE sous PostgreSQL : sans
 * cette precision, une liste sans rang devancerait celles que l'utilisateur a
 * explicitement placees.
 *
 * ⚠️ NE LEVE JAMAIS. Un echec de lecture ne doit pas empecher la notification
 * de partir : on retombe sur le canal par defaut, et le message s'annonce avec
 * le son historique plutot que pas du tout.
 */
export async function canalPourExpediteur(prisma, recipientId, senderId) {
  if (!recipientId || !senderId) return CANAL_MESSAGE_PAR_DEFAUT;
  try {
    const liste = await prisma.contactList.findFirst({
      where: {
        userId: recipientId,
        ringtoneMessage: { not: null },
        members: { some: { memberId: senderId } },
      },
      orderBy: [
        { ordre: { sort: "asc", nulls: "last" } },
        { createdAt: "asc" },
        { id: "asc" },
      ],
      select: { ringtoneMessage: true },
    });
    return canalMessagePour(liste?.ringtoneMessage);
  } catch {
    return CANAL_MESSAGE_PAR_DEFAUT;
  }
}
