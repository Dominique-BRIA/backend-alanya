# Chapitre 31 — Chiffrer un groupe : choisir ce qu'on protège

> **Où nous en sommes.** 08/10/2026. Les conversations à deux sont chiffrées
> de bout en bout depuis fin septembre. Les groupes, eux, ne l'étaient pas :
> le périmètre les refusait (« pas encore supportés »). Ce chapitre raconte
> une journée de **conception**, sans une ligne de code : comment on a choisi
> la façon de chiffrer un groupe, et pourquoi la première recommandation a
> été abandonnée deux fois.
>
> Document de référence : `docs/2026-10-08-e2ee-groupes-conception.md`.

---

## 1. Ce qui rend un groupe difficile

À deux, une session Signal relie **deux appareils**. Chaque message fait
avancer un cliquet, et une clé volée ne révèle ni le passé, ni (longtemps)
l'avenir.

Dans un groupe, trois questions nouvelles apparaissent :

| Question | Pourquoi elle est nouvelle |
|---|---|
| Comment chiffrer **une fois** pour **N** personnes ? | à deux, il n'y a qu'un destinataire |
| Que fait-on quand quelqu'un **arrive** ? | il n'avait pas les clés du passé |
| Que fait-on quand quelqu'un **part** ? | il a encore les clés |

Il n'existe pas **une** bonne réponse : chaque messagerie choisit ce qu'elle
protège. La leçon de ce chapitre est là.

## 2. Première idée : une enveloppe par appareil

La solution la plus simple réutilise tout l'existant : l'expéditeur chiffre
le message **séparément** pour chaque appareil de chaque membre, avec les
sessions à deux déjà en place.

Avec les groupes réels de la production (2 à 8 membres), c'était parfait. On
l'a donc recommandé.

### L'erreur : raisonner sur les chiffres d'aujourd'hui

Le user a corrigé : « nos groupes n'ont pas de limite, c'est juste la phase de
développement ; on vise 300 à 500 membres ». Le calcul change tout :

| Pour une photo, groupe de 500 membres à 2 appareils | Coût |
|---|---|
| Enveloppes | 1 000 |
| Données envoyées par l'expéditeur | environ **40 Mo** (l'aperçu voyage dans chaque enveloppe) |

> **Leçon.** Une conception se dimensionne sur la **cible**, pas sur la base de
> développement. Demandez toujours l'ordre de grandeur visé.

## 3. Deuxième idée : les Sender Keys de Signal

WhatsApp et Signal chiffrent leurs groupes avec les **Sender Keys** : chaque
membre a une clé d'envoi, distribuée une fois aux autres par les sessions à
deux ; ensuite, chaque message est chiffré **une seule fois**.

### Vérifier avant d'affirmer

La bibliothèque du mobile (`libsignal_protocol_dart`) les fournit. Celle du
web (`@privacyresearch/libsignal-protocol-typescript`) non. Une autre IA a
affirmé le contraire, citant `GroupCipher`, `GroupSessionBuilder` et
`SenderKeyStore`.

On a vérifié, sur pièces :

| Source | Résultat |
|---|---|
| les 34 fichiers du paquet installé | aucun de ces noms |
| le code source sur GitHub (`src/types.ts`) | l'interface de stockage ne connaît que les sessions à deux |
| les versions publiées | 0.0.16, la nôtre, est la dernière (mai 2023) |
| la bibliothèque **Dart** | ✅ ces noms y sont |

L'autre IA avait attribué au paquet web les classes d'une **autre**
bibliothèque.

> **Leçon.** Une affirmation technique précise se **vérifie**, quelle que soit
> la confiance qu'inspire sa source — y compris quand c'est nous qui l'avons
> faite. Cherchez le nom dans le code installé, le code source, et les versions
> publiées. Trois sources qui concordent valent mieux qu'une explication
> convaincante.

## 4. Le tournant : « un nouveau membre voit l'historique »

Le user a choisi : contrairement à WhatsApp, un nouveau membre **voit les
anciens messages**. Et chacun doit pouvoir **changer de téléphone** sans rien
perdre.

C'est l'exact **contraire** de ce pour quoi les Sender Keys existent. Leur
raison d'être est qu'une clé, une fois utilisée, soit oubliée : on ne peut
pas relire le passé. La bibliothèque le montre d'ailleurs dans son code : elle
ne garde que **5** générations de clés par expéditeur, et refuse de sauter
plus de **2 000** messages.

Garder les Sender Keys **et** archiver leurs clés pour l'historique, c'était
construire une protection pour la contourner aussitôt : deux fois plus de
complexité, pour une propriété qu'on annule.

## 5. La solution retenue : le trousseau de groupe

- Une **clé de groupe** de 32 octets, tirée au hasard.
- Chaque message est chiffré **une fois** avec elle (AES-GCM) et **signé** par
  son expéditeur.
- La clé a des **versions** : une nouvelle quand un administrateur exclut
  quelqu'un, ou quand on soupçonne un vol.
- Le **trousseau** (toutes les versions) voyage d'appareil à appareil par les
  sessions Signal à deux.

### Pourquoi signer

Tous les membres ont la même clé. Sans signature, n'importe lequel pourrait
écrire un message **au nom d'un autre**. La signature utilise la clé d'identité
de l'appareil, déjà connue par la session à deux.

⚠️ On vérifie avec la clé **déjà connue**, jamais avec une clé redemandée au
serveur à cette occasion : un serveur malveillant pourrait en fournir une
fausse, et signer à la place de quelqu'un.

### Pourquoi des « données associées »

Le chiffré est lié à son contexte : le groupe, le message, la version,
l'expéditeur, l'appareil. Si le serveur le déplace ou le réattribue, le
déchiffrement échoue. C'est la même idée que l'identifiant chiffré dans la
charge v2 (chapitre 26), poussée un cran plus loin.

### « Il faudra tout rechiffrer ? » — Non

Le user s'est inquiété : changer de clé obligerait à rechiffrer l'historique.
Non : chaque message garde **la version** qui l'a chiffré. La v2 ne sert
qu'aux messages écrits **après**. Le trousseau garde toutes les versions, et
pèse environ **50 octets** par version : 1 000 versions font 50 Ko, moins
qu'une photo.

Et on ne peut pas « compresser » le trousseau en déduisant v2 de v1 : un exclu
qui garde v1 pourrait alors calculer v2.

## 6. Le départ d'un membre : ce qu'un booléen peut, et ne peut pas

Le user a proposé un champ `isMembre` : un ancien membre ne doit plus rien
voir. Puis, plus tard : « on n'a qu'à supprimer son trousseau, inutile de
changer la clé ».

Il faut distinguer deux protections de nature différente :

| Protection | Ce qu'elle empêche | Ce qu'elle n'empêche pas |
|---|---|---|
| `est_membre = false` (le serveur ne sert plus les messages) | l'ancien membre qui interroge l'API | une fuite de la base, un serveur piraté |
| effacer son trousseau (serveur et application) | l'ancien membre honnête | celui qui a copié la clé avant de partir |
| **nouvelle version de clé** | même avec la base, il ne lit rien de nouveau | — |

Un booléen et un effacement à distance sont des **contrôles d'accès** : ils
comptent sur la coopération du serveur ou de l'appareil. Seule une nouvelle
clé est une **garantie cryptographique**.

**Décision retenue (option B)** : effacement du trousseau et `est_membre = false`
à **tout** départ ; **nouvelle clé seulement à l'exclusion** par un
administrateur — le cas où l'on a des raisons de se méfier. Un membre parti
de lui-même n'est donc exclu que par le serveur et par son application, et
le cours le dit franchement.

## 7. Le mot de passe protège l'archive

On a proposé une clé de récupération obligatoire pour l'archive personnelle,
qui contiendra désormais les trousseaux. Le user a refusé : « rien à retenir ;
découvrir le mot de passe revient de toute façon à se connecter ».

C'est défendable, et la vérification l'a confirmé : la serrure « mot de
passe » de l'archive est en **Argon2id** (64 Mio, 3 passes), conçue contre
l'attaque hors ligne. Le risque qui reste — le mot de passe transite vers le
serveur à la connexion — existait déjà pour les conversations à deux : ce
choix n'en crée pas de nouveau.

## 8. Est-ce encore du chiffrement de bout en bout ?

Oui : seuls les appareils des membres ont les clés, et le serveur ne lit
rien. Mais c'est une variante **moins stricte** que Signal sur un point :

| | Signal / WhatsApp | Alanya |
|---|---|---|
| Une clé volée ne révèle pas le passé | ✅ | ❌ elle révèle l'historique |
| Un nouveau membre lit le passé | ❌ | ✅ |

C'est le compromis d'**Element / Matrix**, et il découle directement de la
décision « historique pour tous ». Aucun système ne peut offrir les deux à la
fois : relire le passé, c'est garder les clés du passé.

## 9. Le piège trouvé en chemin : les messages écrits par le serveur

Les codes OTP et la messagerie vocale sont écrits **par le serveur** au nom d'un
compte. Or le serveur ne peut pas écrire dans une conversation chiffrée. Si
quelqu'un chiffrait sa conversation avec un compte qui envoie des codes, ses
codes **ne lui arriveraient plus**.

Ce n'est pas théorique : **4 comptes personnels** envoient déjà par l'API.
Décision : un futur compte système « Alanya » enverra ces messages, exclu du
chiffrement. En attendant, on interdit de chiffrer un tête-à-tête avec un
compte émetteur.

> **Leçon.** Avant d'étendre un périmètre, cherchez **qui écrit** dans les
> conversations concernées. Un message qui n'est pas écrit par une personne
> ne peut pas être chiffré de bout en bout.

## 10. À retenir

- Dimensionner sur la **cible**, pas sur les données de développement.
- **Vérifier** une affirmation technique sur pièces, d'où qu'elle vienne.
- Choisir un protocole, c'est choisir **ce qu'on protège** : l'historique
  partagé et la confidentialité persistante s'excluent.
- Un booléen ou un effacement à distance contrôlent l'**accès** ; seule une
  nouvelle clé **garantit**.
- Un message signé et lié à son contexte ne peut être ni usurpé ni déplacé.
- Avant d'élargir le périmètre du chiffrement, chercher qui écrit **à la place**
  des personnes.
