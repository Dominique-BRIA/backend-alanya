import { prisma } from "@/lib/prisma";

/**
 * LES PAGES LÉGALES (18/11/2026, publication sur le Play Store).
 *
 * Google exige une politique de confidentialité PUBLIQUE et des conditions
 * d'utilisation pour une messagerie. Elles vivent en base (`pages_legales`) et
 * se modifient depuis la console de gestion, sans redéployer. Tant que la
 * console n'a rien enregistré, la première version ci-dessous est servie.
 *
 * ⚠️ PREMIÈRE VERSION, À RELIRE : les mentions entre crochets (éditeur,
 * adresse, contact) sont à compléter depuis la console, et le tout mérite la
 * relecture d'un juriste avant la publication.
 *
 * Le contenu est du Markdown simple : titres `##`, listes `-`, gras `**`.
 */

export const SLUGS_LEGAUX = ["confidentialite", "conditions"] as const;
export type SlugLegal = (typeof SLUGS_LEGAUX)[number];

export function estSlugLegal(s: string): s is SlugLegal {
  return (SLUGS_LEGAUX as readonly string[]).includes(s);
}

export interface PageLegaleLue {
  slug: SlugLegal;
  titre: string;
  contenu: string;
  version: number;
  majLe: string | null;
  /** Vrai tant que la console n'a rien enregistré : c'est la version d'origine. */
  parDefaut: boolean;
}

const CONFIDENTIALITE = `Dernière mise à jour : voir la date en bas de page.

Cette politique explique quelles données l'application **Alanya Work** (Android, web) recueille, pourquoi, avec qui elles sont partagées, combien de temps elles sont gardées, et comment exercer vos droits.

**Éditeur :** [nom de l'éditeur ou de la société, adresse]. **Contact :** [adresse e-mail de contact].

## 1. Les données que nous recueillons

- **Votre compte :** adresse e-mail, nom, pseudo, Alanya ID (numéro public), photo de profil, message de statut, mot de passe (stocké uniquement sous forme chiffrée irréversible).
- **Vos messages :** les conversations à deux et les groupes chiffrés sont **chiffrés de bout en bout**. Le serveur transporte des messages chiffrés qu'il ne peut pas lire. Il conserve seulement ce qu'il faut pour les livrer : l'expéditeur, le destinataire, l'heure et l'état (envoyé, reçu, lu).
- **Vos photos, vidéos, vocaux et documents :** dans une conversation chiffrée, ils sont chiffrés sur votre appareil avant l'envoi. Le serveur stocke un fichier illisible.
- **La sauvegarde chiffrée :** si vous l'activez, une copie de votre historique est chiffrée avec une clé dérivée de votre mot de passe. Nous ne pouvons pas la lire.
- **Les appels :** l'heure, la durée et les participants. Le son et l'image passent directement entre les appareils ou par un relais, sans être enregistrés.
- **La position :** uniquement si vous l'activez (partage d'une position dans une conversation, ou suivi demandé par votre organisation pour les comptes concernés). Le suivi en arrière-plan n'a lieu qu'après votre accord explicite et se coupe dans les paramètres.
- **L'Assistant Alanya :** les questions que vous lui posez et ses réponses, pour vous les rendre dans l'historique de l'Assistant.
- **Les données techniques :** identifiant de l'appareil pour la connexion, jeton de notification, adresse IP (sécurité et limitation des abus), journaux d'erreurs.
- **Les signalements :** quand vous signalez un message, un compte, un groupe ou une réponse de l'Assistant, le motif et, pour un message chiffré, le texte que **vous** choisissez de nous transmettre.

Nous n'importons pas votre carnet d'adresses et nous ne vendons aucune donnée.

## 2. Pourquoi nous les utilisons

- Fournir le service : créer votre compte, livrer messages et appels, afficher les notifications.
- Sécuriser le service : prévenir la fraude, les abus et le spam, traiter les signalements.
- Répondre à vos demandes et vous informer des changements importants.

## 3. Avec qui elles sont partagées

Uniquement avec les prestataires nécessaires au fonctionnement, pour ce seul usage :

- **Google Firebase** : acheminement des notifications.
- **Google (Gemini)** : production des réponses de l'Assistant Alanya, à partir de vos questions.
- **Cloudflare** : relais des appels et stockage de fichiers.
- **Backblaze** : stockage des fichiers (chiffrés pour les conversations chiffrées).
- **Notre hébergeur de serveurs** et **notre prestataire d'e-mails** (codes de vérification).
- **MapTiler** : affichage des cartes.

Nous pouvons aussi transmettre des données si la loi nous y oblige.

## 4. Durée de conservation

- Le compte et son contenu : tant que le compte existe.
- Les messages chiffrés en attente de livraison : jusqu'à leur livraison, puis 30 jours au plus.
- Les journaux techniques : [durée à préciser].
- À la suppression du compte, les données sont effacées, sauf obligation légale de conservation.

## 5. Vos droits

Vous pouvez consulter et modifier vos informations dans l'application, et **supprimer votre compte** :

- dans l'application : Paramètres, puis Supprimer mon compte ;
- sur le web, même sans l'application : https://alanyavox.com/suppression-compte

Pour toute autre demande (accès, rectification, opposition), écrivez à [adresse e-mail de contact].

## 6. Sécurité

Chiffrement de bout en bout des conversations chiffrées, connexions chiffrées (HTTPS), mots de passe hachés, contrôle des appareils connectés.

## 7. Enfants

Le service n'est pas destiné aux enfants de moins de [13 / 16] ans.

## 8. Modifications

Nous pouvons modifier cette politique. La date de mise à jour figure en bas de page ; un changement important vous sera signalé dans l'application.`;

const CONDITIONS = `Dernière mise à jour : voir la date en bas de page.

En créant un compte ou en utilisant **Alanya Work**, vous acceptez les présentes conditions.

**Éditeur :** [nom de l'éditeur ou de la société, adresse]. **Contact :** [adresse e-mail de contact].

## 1. Le service

Alanya Work est une messagerie : conversations à deux et en groupe, appels audio et vidéo, réunions, statuts, partage de fichiers et Assistant Alanya.

## 2. Votre compte

- Vous devez avoir au moins [13 / 16] ans.
- Les informations de votre compte doivent être exactes. Un compte qui se fait passer pour une autre personne ou une organisation peut être suspendu.
- Vous êtes responsable de votre mot de passe et des appareils connectés à votre compte.

## 3. Règles de la communauté

Il est interdit d'utiliser Alanya Work pour :

- harceler, menacer, intimider ou inciter à la violence ;
- diffuser des propos haineux ou discriminatoires ;
- diffuser du contenu sexuel impliquant des mineurs, ou du contenu sexuel non consenti ;
- escroquer, frauder ou hameçonner ;
- envoyer du spam ou des messages en masse non sollicités ;
- usurper l'identité d'une personne ou d'une organisation ;
- diffuser des logiciels malveillants, ou porter atteinte au fonctionnement du service ;
- enfreindre la loi ou les droits d'autrui (droits d'auteur, vie privée).

## 4. Signaler et bloquer

Vous pouvez **signaler** un message, un compte, un groupe ou une réponse de l'Assistant, et **bloquer** un compte. Les signalements sont examinés par notre équipe de modération, qui peut retirer un contenu, avertir, suspendre ou exclure un compte.

Dans une conversation chiffrée, nous ne pouvons pas lire les messages : nous ne voyons que ce que la personne qui signale choisit de nous transmettre.

## 5. L'Assistant Alanya

Les réponses de l'Assistant sont produites automatiquement par une intelligence artificielle. Elles peuvent être inexactes : vérifiez-les avant de vous y fier, en particulier pour la santé, le droit ou l'argent. Signalez toute réponse choquante ou dangereuse.

## 6. Vos contenus

Vous restez propriétaire de ce que vous envoyez. Vous nous accordez seulement le droit de le transporter et de le stocker pour faire fonctionner le service.

## 7. Suspension et suppression

Nous pouvons suspendre ou supprimer un compte qui enfreint ces conditions. Vous pouvez supprimer votre compte à tout moment, dans l'application ou sur https://alanyavox.com/suppression-compte

## 8. Responsabilité

Le service est fourni tel quel. Nous faisons notre possible pour qu'il soit disponible et sûr, sans pouvoir garantir l'absence d'interruption.

## 9. Modifications

Nous pouvons modifier ces conditions. La date de mise à jour figure en bas de page ; un changement important vous sera signalé dans l'application.

## 10. Droit applicable

[Droit applicable et juridiction compétente, à préciser].`;

const DEFAUTS: Record<SlugLegal, { titre: string; contenu: string }> = {
  confidentialite: { titre: "Politique de confidentialité", contenu: CONFIDENTIALITE },
  conditions: { titre: "Conditions d'utilisation", contenu: CONDITIONS },
};

export async function lirePageLegale(slug: SlugLegal): Promise<PageLegaleLue> {
  const ligne = await prisma.pageLegale.findUnique({ where: { slug } });
  if (!ligne) {
    return { slug, ...DEFAUTS[slug], version: 0, majLe: null, parDefaut: true };
  }
  return {
    slug,
    titre: ligne.titre,
    contenu: ligne.contenu,
    version: ligne.version,
    majLe: ligne.majLe.toISOString(),
    parDefaut: false,
  };
}

/** Enregistre une nouvelle version, depuis la console. */
export async function enregistrerPageLegale(
  slug: SlugLegal,
  titre: string,
  contenu: string,
  auteur: string,
): Promise<PageLegaleLue> {
  await prisma.pageLegale.upsert({
    where: { slug },
    create: { slug, titre, contenu, version: 1, majPar: auteur },
    update: { titre, contenu, version: { increment: 1 }, majLe: new Date(), majPar: auteur },
  });
  return lirePageLegale(slug);
}
