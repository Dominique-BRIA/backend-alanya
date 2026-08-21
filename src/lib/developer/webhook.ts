import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import type { StatutMessage } from "./api-contract";

/**
 * LES RAPPELS HTTP (webhooks) VERS L'ABONNÉ.
 *
 * 🔴 LA SIGNATURE NE SIGNAIT RIEN. L'en-tête `X-Alanya-Signature` transportait
 * `webhook.secretKey` **en clair**, c'est-à-dire le secret lui-même. Deux
 * conséquences, et la seconde est la pire :
 *
 * - elle ne prouvait rien : n'importe qui ayant vu passer une seule de nos
 *   requêtes pouvait rejouer l'en-tête et se faire passer pour nous, donc
 *   annoncer à l'abonné n'importe quel statut sur n'importe quel message ;
 * - elle **publiait le secret** à chaque appel, chez le destinataire, dans ses
 *   journaux d'accès et chez tout intermédiaire du trajet.
 *
 * Le contrat du 18/08/2026 annonçait le passage au HMAC et interdisait de
 * documenter la vérification avant. C'est fait, et le moment est le bon : le
 * récepteur d'en face n'est pas encore écrit.
 *
 * ## Ce qu'un récepteur doit faire
 *
 * ```
 * X-Alanya-Signature: sha256=<hex>
 * ```
 *
 * `<hex>` est `HMAC-SHA256(corps_brut, secretKey)`. Le corps **brut** — les
 * octets reçus, avant tout `JSON.parse` puis re-sérialisation, qui changerait
 * l'espacement et donc l'empreinte. La comparaison se fait à temps constant
 * (`crypto.timingSafeEqual`), jamais par `===`.
 *
 * ⚠️ Sans `secretKey` configuré, AUCUN en-tête de signature n'est envoyé — au
 * lieu d'en envoyer un faux. Un récepteur qui rejette les requêtes non signées
 * fait alors le bon choix, ce qu'un en-tête décoratif lui interdisait.
 */

/** Nom de l'en-tête. Inchangé : c'est son CONTENU qui devient vérifiable. */
export const ENTETE_SIGNATURE = "X-Alanya-Signature";

/** `sha256=<hex>` — le préfixe nomme l'algorithme, comme le fait WhatsApp. */
export function signerCorps(corps: string, secret: string): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(corps, "utf8").digest("hex")}`;
}

/**
 * Notifie l'abonné du statut d'un message.
 *
 * 🔴 LA CHARGE N'IMITE PLUS WhatsApp Cloud API. Elle empilait
 * `entry[0].changes[0].value.statuses[0]` — quatre niveaux et trois tableaux à
 * un seul élément — pour transporter trois valeurs. Ce format n'existe chez
 * Meta que parce qu'un même appel y regroupe plusieurs comptes et plusieurs
 * événements ; nous n'en envoyons jamais qu'un. Personne n'ayant intégré l'API,
 * la charge est celle qu'elle aurait dû être :
 *
 * ```json
 * { "evenement": "message.statut",
 *   "emisA": "2026-08-21T14:02:11.482Z",
 *   "donnees": { "messageId": "<uuid>", "statut": "ENVOYE",
 *                "destinataire": "12345678" } }
 * ```
 *
 * `evenement` est nommé dès maintenant, alors qu'il n'a qu'une valeur : c'est
 * lui qui permettra d'en ajouter d'autres sans que le récepteur ait à deviner
 * à la forme ce qu'il vient de recevoir.
 *
 * Ne lève jamais : un rappel est un service rendu, pas une condition de
 * l'envoi. L'appelant l'invoque avec `void`.
 */
export async function notifierStatutMessage(
  developerId: string,
  messageId: string,
  statut: StatutMessage,
  numeroDestinataire: string,
): Promise<void> {
  try {
    const webhook = await prisma.developerWebhook.findUnique({
      where: { developerId, isActive: true },
    });

    if (!webhook || !webhook.url) return;

    const charge = {
      evenement: "message.statut",
      // ISO-8601 et non un horodatage Unix en SECONDES comme le faisait le
      // format précédent : la seconde est trop grossière pour ordonner deux
      // statuts d'un même message, et une chaîne ISO se lit sans conversion.
      emisA: new Date().toISOString(),
      donnees: {
        messageId,
        statut,
        destinataire: numeroDestinataire,
      },
    };

    /*
     * Le corps est sérialisé UNE FOIS et c'est cette chaîne qui est signée PUIS
     * envoyée. Signer un objet re-sérialisé au moment de l'envoi produirait une
     * empreinte valable pour un texte que le destinataire ne recevra pas
     * forcément octet pour octet.
     */
    const corps = JSON.stringify(charge);

    const entetes: Record<string, string> = { "Content-Type": "application/json" };
    if (webhook.secretKey) {
      entetes[ENTETE_SIGNATURE] = signerCorps(corps, webhook.secretKey);
    }

    void fetch(webhook.url, { method: "POST", headers: entetes, body: corps }).catch(() => {});
  } catch {
    // Silencieux : l'échec d'un rappel ne remonte pas jusqu'à l'expéditeur.
  }
}
