# Chapitre 41 — Le rattrapage par l'archive

> **Où nous en sommes.** 10/10/2026. Le user montre une capture : dans un
> tête-à-tête chiffré, sur un navigateur de téléphone, cinq messages de Toti
> (dont une vidéo) affichent « indisponible sur cet appareil ». Son
> hypothèse : « la reprise de session par jeton n'a pas le mot de passe, donc
> l'archive ne s'ouvre pas ». Ce chapitre raconte l'enquête, qui a donné
> **une autre cause**, puis la correction.
>
> Backend `aaa2e7a`, web `78ab332`, mobile `bcdb7e2`.

---

## 1. Enquêter sur les données, pas sur l'hypothèse

L'hypothèse était plausible. Avant de corriger quoi que ce soit, on a lu le
code, puis la base de production **en lecture seule**.

### Ce que dit le code

La clé de l'archive est rangée dans le **coffre local** du navigateur
(chiffré par une clé non extractible) et **relue** à chaque rechargement. Une
session reprise par jeton l'a donc, sans mot de passe. Le coffre lui-même
(identité Signal, sessions) ne dépend pas du mot de passe non plus.

→ L'hypothèse ne tient pas d'office. Il faut des faits.

### Ce que dit la base

| Heure | Événement |
|---|---|
| 09/10 19:49 | l'ordinateur de steve (« Chrome sur Linux ») crée son identité |
| 10/10 08:59 | dernière activité de cet ordinateur |
| 11:14 → 12:21 | Toti envoie 5 messages, chiffrés pour les **3 appareils connus** de steve |
| 12:22 | steve se connecte depuis le **navigateur de son téléphone** : un appareil **neuf** |
| 12:22 | une seule session web par compte : l'ordinateur est **évincé** |
| 12:31 | le navigateur du téléphone publie son identité, toute neuve |

Et surtout : les **15 enveloppes** (5 messages × 3 appareils) n'ont **jamais
été remises**.

> 🎓 **Leçon.** Une hypothèse plausible n'est pas un diagnostic. Ici, deux
> requêtes en lecture seule ont suffi à la remplacer par la vraie chronologie.

## 2. La vraie cause

Le chiffrement de bout en bout fonctionne **par appareil** : Toti chiffre une
copie pour chaque appareil de steve **qui existe au moment de l'envoi**. Le
navigateur du téléphone n'existait pas encore → **aucune copie pour lui**, et
il n'y en aura jamais.

Le seul recours d'un nouvel appareil, c'est l'**archive** : les autres
appareils du compte y déposent ce qu'ils ont lu. Deux trous :

1. **Personne n'avait lu ces messages** : l'ordinateur dormait. Rien n'était
   dans l'archive.
2. **Le web ne lisait l'archive qu'une fois, à la connexion.** Même si
   l'ordinateur se réveillait et archivait ces messages ensuite, le navigateur
   du téléphone ne l'apprendrait jamais.

Le trou n°1 est inhérent au chiffrement : on ne peut pas lire ce que personne
n'a déchiffré. Le trou n°2, lui, est un **défaut** — c'est lui qu'on corrige.

## 3. La correction : un curseur et un rattrapage

### Côté serveur

`GET /api/e2ee/archive` rendait `suivant` — l'identifiant du dernier bloc
**seulement s'il restait une page**. On ajoute `dernier` : le dernier bloc
rendu, **toujours**. C'est un **ajout pur** : les clients actuels l'ignorent.

### Côté web

- Chaque appareil retient un **curseur** : le dernier bloc d'archive qu'il a
  lu (en `localStorage`, sous le préfixe `alanya.e2ee.`, vidé à la
  déconnexion).
- La restauration de connexion **pose** ce curseur.
- Quand un fil chiffré contient des messages en tête-à-tête **sans texte ni
  média**, le chargement du fil appelle `rattraperDepuisArchive` :
  - il lit les blocs **après** le curseur (`?apres=…`) — en général aucun ou
    très peu ;
  - il range tout ce qu'ils contiennent dans le cache ;
  - il complète aussitôt les bulles vides ;
  - il avance le curseur.
- Un **repos de 20 secondes** entre deux rattrapages : un fil rechargé à
  chaque message n'en lance pas un à chaque fois.
- Un curseur **inconnu du serveur** (archive effacée puis recréée) : on repart
  du début, une fois.

### Côté mobile

Le mobile avait **déjà** un rattrapage à l'ouverture d'un fil. Mais il ne
partait que pour un **texte** manquant. Une vidéo sans sa clé restait
« Média chiffré — indisponible ». La condition couvre maintenant les médias
(image, vidéo, audio, fichier) sans descripteur.

> 🎓 **Leçon.** Quand deux clients font « la même chose », comparer leurs
> **conditions de déclenchement** est souvent plus instructif que comparer
> leur code : ici, le mobile savait rattraper, mais pas dans tous les cas.

## 4. Les erreurs rencontrées, et leurs solutions

### a) « B1 a archivé : 0 → 0 »

Le banc comptait les blocs d'archive **juste après** que le premier navigateur
eut relevé les messages : zéro. Pourtant le second navigateur les retrouvait
ensuite.

**Cause.** L'archivage est **différé** : les messages attendent dans un tampon
(jusqu'à 10 messages ou quelques secondes) avant d'être déposés en un bloc.

**Solution.** Le banc pousse le tampon (`vider()`) puis **attend** que le bloc
apparaisse, au lieu de compter une fois.

### b) Le rattrapage « fantôme » qui ne partait jamais

Pour prouver l'usage du curseur, le banc envoyait un message puis supprimait
l'enveloppe du second navigateur — pour qu'il reste indisponible. Aucune
requête de rattrapage n'est partie.

**Cause.** Le second navigateur, ouvert, avait **déjà relevé** l'enveloppe
(sonnette temps réel) avant sa suppression : le message était lisible, rien
ne manquait, donc pas de rattrapage. Le même piège qu'au chapitre 39.

**Solution.** Appeler le rattrapage directement, et vérifier que sa requête
porte `?apres=<curseur>`.

> 🎓 **Leçon.** Dans un banc avec du temps réel, « supprimer une donnée pour
> simuler son absence » est une course perdue d'avance si un client en ligne
> peut la consommer avant. Soit on ferme ce client, soit on teste la fonction
> directement.

## 5. Les preuves

| Banc | Résultat |
|---|---|
| `STAGE-WEB/scripts/e2ee-rattrapage-archive.mjs` — le cas réel rejoué : B1 endormi, B2 neuf « indisponible », B1 réveillé **par son jeton** relève et archive, B2 lit texte et fichier (octet pour octet), survit au rechargement, curseur utilisé | 18 ✓ — TOUT EST VERT |
| `restauration-navigateur.mjs` (la restauration de connexion, dont `restaurer` a changé) | TOUT EST VERT |
| Suite mobile | 414 ✓ |

## 6. Ce qui reste vrai

- **Un message que personne n'a jamais déchiffré ne se rattrape pas.** Si
  aucun appareil existant à l'envoi ne se reconnecte, il reste
  indisponible : c'est le prix du chiffrement de bout en bout.
- Pour les 5 messages de steve : ils attendent toujours sur le serveur pour
  ses anciens appareils. Dès que l'un d'eux (l'application Android, ou
  l'ordinateur) se reconnecte et les relève, ils sont archivés — et le
  navigateur du téléphone les rattrape tout seul.
