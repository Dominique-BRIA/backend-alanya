import { previensDesPersonnes } from "@/lib/salle-temps-reel";
import { prisma } from "@/lib/prisma";
import { MEMBRE_ACTIF } from "@/lib/appartenance.mjs";
import { enSourdinePour } from "@/lib/groupe-droits.mjs";
import { nomAffichage } from "@/lib/display-name.mjs";

/**
 * ANNONCER UN MESSAGE CHIFFRÉ : la sonnette temps réel, puis la notification.
 *
 * Extrait de `POST /api/e2ee/enveloppes` le 09/10/2026 : le message de GROUPE
 * chiffré a besoin exactement de la même annonce, mais il ne passe pas par
 * les enveloppes — son unique chiffré s'écrit avec la ligne du message. Deux
 * copies de ce bloc auraient divergé (la notification en double du commit
 * 445266e venait déjà d'une copie de trop). L'historique des défauts corrigés
 * est resté dans la route des enveloppes.
 *
 * 🔴 LA NOTIFICATION EST GÉNÉRIQUE, ET ELLE DOIT LE RESTER : le serveur ne
 * connaît pas le texte, et une notification traverse Google ou Apple avant de
 * s'afficher sur un écran verrouillé. `preview: null` → « Nouveau message ».
 *
 * ⚠️ RIEN ICI NE PEUT FAIRE ÉCHOUER L'ENVOI. Le message est écrit et valide ;
 * au pire il arrivera à la prochaine ouverture.
 */
export async function annoncerMessageChiffre(params: {
  convId: string;
  expediteurId: string;
  messageId: string;
  /** Les comptes à prévenir. L'expéditeur peut y figurer (ses autres appareils). */
  personnes: string[];
  /** Champs ajoutés à la trame (`groupe: true`, `modifie: true`…). */
  extra?: Record<string, unknown>;
  /** Faux pour une modification : on prévient, on ne notifie pas. */
  notifier?: boolean;
}): Promise<void> {
  const { convId, expediteurId, messageId } = params;
  const personnes = [...new Set(params.personnes)];

  await previensDesPersonnes({
    personnes,
    type: "e2ee_arrivee",
    donnees: { convId, messageId, ...(params.extra ?? {}) },
  });

  if (params.notifier === false) return;

  /*
   * ⚠️ ON NE SE NOTIFIE PAS SOI-MÊME (la sonnette, si : ses autres appareils
   * doivent relever), et LA SOURDINE coupe la notification, jamais la sonnette.
   */
  const autres = personnes.filter((id) => id !== expediteurId);
  if (autres.length === 0) return;
  try {
    /*
     * LA SOURDINE COMPLÈTE (01/11/2026) : pour toujours, pour un temps, ou
     * « mentions seulement ». Les mentions d'un message chiffré sont gardées
     * en clair à côté (`message_mentions`) : elles sont lisibles ici.
     */
    const [membres, cite, message] = await Promise.all([
      prisma.participant.findMany({
        where: { convId, userId: { in: autres }, ...MEMBRE_ACTIF },
        select: { userId: true, sourdine: true, sourdineJusqua: true, mentionsSeulement: true },
      }),
      prisma.messageMention.findMany({ where: { messageId }, select: { userId: true } }),
      prisma.message.findUnique({ where: { id: messageId }, select: { mentionneTous: true } }),
    ]);
    const mentionnes = new Set(cite.map((m) => m.userId));
    const enGroupe = (await prisma.conversation.findUnique({
      where: { id: convId },
      select: { isGroup: true },
    }))?.isGroup === true;
    const enSourdine = new Set(
      membres
        .filter((m) =>
          enSourdinePour(m, {
            mentionne: message?.mentionneTous === true || mentionnes.has(m.userId),
            enGroupe,
          }),
        )
        .map((m) => m.userId),
    );
    const aNotifier = autres.filter((id) => !enSourdine.has(id));
    if (aNotifier.length === 0) return;

    const [{ pushNewMessage }, expediteur, conv] = await Promise.all([
      import("@/../push.mjs"),
      prisma.user.findUnique({
        where: { id: expediteurId },
        select: { nom: true, pseudo: true, publicNumber: true },
      }),
      prisma.conversation.findUnique({ where: { id: convId }, select: { isGroup: true, name: true } }),
    ]);
    await Promise.all(
      aNotifier.map((destinataireId) =>
        pushNewMessage(prisma, {
          recipientId: destinataireId,
          /*
           * 🐛 « NOUVEAU MESSAGE », SANS NOM (signalé par le user, 24/10/2026).
           * Seul le `nom` était lu : vide chez 54 comptes sur 108, qui n'ont
           * qu'un pseudo. Le titre retombait alors sur « Nouveau message ».
           * `nomAffichage` — nom, puis pseudo, puis Alanya ID — est la règle
           * des messages en clair, de la messagerie vocale et des diffusions.
           * Le nom donné par le destinataire passe encore devant
           * (`pushNewMessage`).
           */
          senderName: (expediteur ? nomAffichage(expediteur) : null) ?? "",
          senderId: expediteurId,
          convId,
          // Le NOM d'un groupe, que le serveur connaît de toute façon : sans
          // lui, la notification ne dit pas dans quel groupe on a écrit.
          convTitle: conv?.isGroup ? (conv.name ?? null) : null,
          // ⚠️ NUL, ET C'EST LE POINT : voir l'en-tête.
          preview: null,
          messageType: "TEXT",
        }),
      ),
    );
  } catch (e) {
    console.error("[e2ee] notification impossible :", e);
  }
}
