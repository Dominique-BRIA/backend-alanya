# Chapitre 34 — Le groupe chiffré dans les applications : écrire, lire, oublier

> **Où nous en sommes.** 10/10/2026. Le chapitre 33 a donné au serveur tout ce
> qu'il faut pour un groupe chiffré (lot 2, en production). Ce chapitre couvre
> les **lots 3 et 4** : le téléphone et le navigateur savent maintenant
> **envoyer**, **lire**, **modifier** un message de groupe, **recevoir** un
> trousseau et l'**oublier** au départ.
>
> Ce qui manque encore : **fabriquer et distribuer** le trousseau depuis
> l'écran (activation, ajout, exclusion — lot 5). Les bancs le distribuent
> « à la main », avec le vrai code.
>
> Web : `src/services/e2ee-groupe-fil.ts`, banc navigateur
> `scripts/e2ee-groupe-web.mjs`. Mobile : `lib/services/e2ee/e2ee_groupe_fil.dart`,
> test `test/e2ee_groupe_fil_test.dart`. Serveur : `src/lib/e2ee-groupe-charge.ts`
> (`idMessageClient`). Commits : backend `17693c9`, web `0200232`,
> mobile `6bf35bf`.

---

## 1. Ce qui change par rapport au tête-à-tête

| | Tête-à-tête | Groupe |
|---|---|---|
| Combien de chiffrés par message | un **par appareil** destinataire | **un seul** pour tous |
| Où il vit | une enveloppe, **effacée** après lecture | avec la ligne du message, **jamais effacé** |
| Où l'appareil garde le texte | le cache local (seule copie) | le cache sert au confort ; le chiffré se relit |
| Clé | la session Signal à deux | la clé du groupe, version `n` |

Conséquence pratique : en groupe, **un nouveau téléphone qui a le trousseau
relit tout l'historique** depuis le serveur. Pas besoin d'archiver chaque
message.

## 2. Le problème de l'œuf et de la poule (erreur ET solution)

### Le problème

La signature du message de groupe couvre **l'identifiant du message**
(chapitre 32 : il est dans les données associées). Il faut donc l'identifiant
**avant** de chiffrer.

Or en tête-à-tête, c'est le **serveur** qui crée l'identifiant : on écrit la
ligne, puis on dépose les enveloppes. En groupe, le chiffré part **avec** la
ligne, en un seul envoi. Impossible de connaître l'identifiant à temps.

Je ne l'avais pas vu au lot 0 : la conception disait « un seul envoi » **et**
« l'identifiant dans la signature », sans voir que les deux se contredisaient.

### La solution

**L'appareil tire l'identifiant lui-même** : un UUID v4, au hasard sûr.

Le serveur vérifie :
- la forme (UUID v4) ;
- qu'il est libre (sinon `409 ID_DEJA_PRIS`) ;
- qu'il n'en reçoit un **que** pour un groupe chiffré.

> 🎓 **Leçon.** Deux décisions justes séparément peuvent être impossibles
> ensemble. La contradiction n'apparaît qu'au moment d'écrire le code : c'est
> pour cela qu'on écrit tôt une brique de bout en bout.

## 3. Envoyer

1. Prendre la version **la plus récente** du trousseau local.
2. Tirer l'identifiant.
3. Écrire la charge v2 (texte, média, citation, genre : la même qu'à deux).
4. Chiffrer et **signer** avec la clé privée d'identité de l'appareil.
5. Un seul `POST`, avec `{ id, groupe: { version, appareil, corps } }`.

### Quand la clé a changé

Si un administrateur vient de changer la clé (exclusion), le serveur répond
`VERSION_PERIMEE`. L'application **ne renvoie pas** avec l'ancienne clé — l'exclu
la connaît. Elle dit : « Clé du groupe pas encore reçue : le message n'est pas
parti. »

## 4. Lire

Dans cet ordre, et chaque étape peut refuser :

1. **La clé de cette version** est-elle dans le trousseau ? Sinon : « en
   attente de la clé ».
2. **La clé d'identité de l'appareil signataire** est-elle connue ?
   - oui : on l'utilise ;
   - non (un membre à qui l'on n'a jamais écrit) : on **ouvre une session à
     deux** avec lui — le chemin ordinaire, qui vérifie ses pré-clés signées et
     retient son identité — puis on la lit.
3. **La signature** est-elle valide ? Sinon : refus, rien d'affiché.
4. **Le déchiffrement**, puis la charge v2 doit annoncer **ce** message.

⚠️ Jamais une clé que le serveur servirait « juste pour vérifier ce message » :
il pourrait en donner une fausse et signer à la place d'un membre.

## 5. Recevoir un trousseau

Il arrive dans une **enveloppe Signal ordinaire**, sans message (hors fil),
avec le préfixe `\u0000G1`. À la relève :

| Contrôle | Pourquoi |
|---|---|
| le groupe écrit dans le chiffré = celui de l'enveloppe | le serveur ne peut pas le détourner vers un autre groupe |
| l'expéditeur est **administrateur**, ou c'est **moi** (un autre de mes appareils) | un simple membre ne distribue pas de clé |
| aucune version connue n'est **remplacée** | on ne peut ni casser l'historique, ni glisser une clé connue d'un autre |

Les **anciens groupes sans administrateur** : le serveur considère le premier
arrivé comme administrateur (`isGroupAdmin`). Les deux applications appliquent
**la même règle**, sinon un trousseau légitime serait refusé.

Le trousseau est rangé dans le **coffre** de l'appareil (navigateur : coffre
chiffré IndexedDB ; téléphone : stockage matériel), comme les clés Signal.

## 6. Oublier

Quand on quitte un groupe chiffré, ou qu'on en est exclu, le serveur sonne
`e2ee_membre_parti` chez le partant. L'application **efface le trousseau**.
Les messages déjà lus restent dans le cache (décision du user, comme
WhatsApp).

## 7. Les bancs

| Banc | Où | Contrôles |
|---|---|---|
| `e2ee-groupe-web.mjs` | vrai Chrome, 3 comptes, serveur local | 21 ✓ |
| `e2ee_groupe_fil_test.dart` | vraie bibliothèque Signal, faux serveur | 11 ✓ |
| `groupe-chiffre-banc.mjs` (serveur) | identifiant tiré : absent, réutilisé | 57 ✓ |

Le banc navigateur prouve aussi, dans l'écran : le serveur n'a **aucun texte
en clair**, **aucune enveloppe** pour un message de groupe, et Bob lit le
message d'Alice dans le fil.

Un **témoin positif** accompagne le refus « non-administrateur » : la même
version, envoyée par l'administratrice, est acceptée. Sans lui, un refus pour
une autre raison (réseau, format) aurait fait passer le test.

## 8. Deux erreurs de ma part (et ce qu'elles apprennent)

### « Le web n'a pas de bouton d'activation »

Je l'ai affirmé au lot 2 pour dire que le déploiement serveur était sans
risque. C'était **faux** : j'avais cherché dans `src/` seulement, et le
bouton vit dans `app/(protected)/chats/[chatId]/chat.tsx`.

Sans conséquence en production : depuis un groupe, ce bouton aurait reçu
`400` (le serveur exige l'appareil qui tirera la clé, que le web n'envoyait
pas). Il est maintenant **inerte en groupe** jusqu'au lot 5, et le dit.

> 🎓 **Leçon.** « Ça n'existe pas » est une affirmation sur **tout** le code.
> Chercher dans un seul dossier ne prouve que l'absence dans ce dossier.

### Deux échecs de bancs qui n'étaient pas les miens

Deux bancs web anciens échouaient. Avant de chercher dans mon code, je les ai
**rejoués sans mes modifications** (`git stash`) :

- `e2ee-releve-multifil` ⑦ attendait que « Transférer » soit **absent** d'un
  message chiffré : règle changée le 07/10 (le navigateur transfère lui-même).
  Le banc était périmé → attente mise à jour.
- `e2ee-media-envoi` : l'aperçu de la première page d'un PDF manque. **Même
  échec sans mes modifications** → défaut antérieur, signalé, pas traité ici.

## 9. Ce qui reste

- **Lot 5** : activer depuis l'écran (tirer la clé, la distribuer à chaque
  appareil), ajout (tout le trousseau au nouveau), exclusion et changement
  manuel (nouvelle version).
- **Lot 6** : la copie personnelle du trousseau et la restauration sur un
  nouveau téléphone.
- **Lot 7** : l'interface (bandeaux « en attente de la clé », messages
  système, vérification par membre).

## 10. À retenir

1. En groupe, **un** chiffré par message, **jamais consommé** : il se relit.
2. Ce qui est signé doit **exister avant** la signature — ici, l'identifiant.
3. On vérifie avec une identité **déjà connue**, ou établie par le chemin
   ordinaire ; jamais servie pour l'occasion.
4. Un trousseau ne vient que d'un **administrateur** ou de **soi-même**, et ne
   **remplace** rien.
5. Un test de refus a besoin de son **témoin positif**.
6. Un banc qui échoue se rejoue **sans** le changement avant d'accuser le
   changement.
