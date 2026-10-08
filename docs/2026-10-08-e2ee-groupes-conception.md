# Chiffrement de bout en bout des groupes — conception (lot 0)

> **Statut.** Conception à relire et valider **avant toute ligne de code**.
> Rédigée le 08/10/2026, à partir des décisions prises avec le user le même
> jour. Le raisonnement pédagogique est dans `docs/cours/31-chiffrer-un-groupe.md`.

---

## 1. Les décisions

| # | Sujet | Décision |
|---|---|---|
| 1 | Méthode | **Trousseau de groupe** : une clé AES par version, tirée au hasard. Les Sender Keys de Signal sont abandonnées. |
| 2 | Activation | par un **administrateur du groupe**, de façon définitive (comme en tête-à-tête) |
| 3 | Historique | **visible** par un nouveau membre : l'administrateur qui l'ajoute lui transmet le trousseau |
| 4 | Changement de téléphone | trousseau restauré depuis l'**archive personnelle**, ouverte par le mot de passe |
| 5 | Départ volontaire | `est_membre = false`, **suppression du trousseau** de la personne, **pas** de nouvelle clé |
| 6 | Exclusion par un administrateur | idem, **plus une nouvelle version de clé** créée par l'appareil de l'administrateur |
| 7 | Clé soupçonnée volée | bouton « Changer la clé du groupe » (administrateurs) : nouvelle version |
| 8 | Types de compte autorisés à chiffrer (tête-à-tête **et** groupe) | 0 personnel, 2 agent, 3 numéro de centre d'appels, 4 centre vocal. **Refusés** : 9 (administrateur de la plateforme), tout type inconnu |
| 9 | Codes OTP, messagerie vocale | un futur **compte système « Alanya »**, exclu du chiffrement. **En attendant** : aucune conversation à deux ne peut être chiffrée avec un compte qui envoie par l'API |
| 10 | Limite de membres | aucune pour l'instant |
| 11 | Ce que voit le serveur | nom et photo du groupe, liste des membres, qui écrit et quand, type et taille des messages, numéro de version de clé |

---

## 2. Cryptographie

### 2.1 La clé de groupe

- **32 octets** tirés par le générateur aléatoire sûr de l'appareil (`crypto.getRandomValues` sur le web, `Random.secure` sur le mobile).
- Une clé par **version** : `v1` à l'activation, puis une nouvelle à chaque exclusion ou changement manuel.
- Les versions sont **indépendantes** : aucune ne se déduit d'une autre. Sinon, un exclu qui garde `v1` pourrait calculer `v2`.

### 2.2 Le message de groupe

Le **contenu** est la charge v2 actuelle, sans aucun changement : `{ v: 2, id, texte, media?, reponseA?, genre?, modifie? }`. Réponse, contact, position, média chiffré et modification fonctionnent donc sans retouche du contenu.

Seule l'**enveloppe** change :

```
corps = base64( format(1 octet = 0x01) | nonce(12) | chiffré+étiquette GCM | signature(64) )
```

| Élément | Valeur |
|---|---|
| Chiffrement | AES-256-GCM, clé = clé de groupe de la version, nonce de 12 octets **tiré au hasard** pour chaque message |
| Données associées (AAD) | `"alanya-groupe-v1" | convId | messageId | version | expéditeurId | deviceId` |
| Signature | XEdDSA (Curve25519) avec la **clé privée d'identité** de l'appareil expéditeur, sur `AAD | nonce | chiffré` |

**Pourquoi les données associées.** Elles collent le chiffré à **son** contexte. Le serveur ne peut pas déplacer un message vers un autre groupe, l'attribuer à un autre expéditeur, ni le servir sous une autre version : le déchiffrement échouerait.

**Pourquoi la signature.** Tous les membres ont la même clé. Sans signature, n'importe lequel pourrait écrire au nom d'un autre.

**⚠️ Vérification de la signature.** Elle se fait avec la clé d'identité **déjà connue** de cet appareil, celle de la session Signal à deux, enregistrée lors du premier échange. **Jamais** avec une clé redemandée au serveur pour l'occasion : un serveur malveillant pourrait en fournir une fausse et signer à la place de quelqu'un. Si l'appareil expéditeur est inconnu, on ouvre d'abord une session à deux, ce qui déclenche les contrôles de clé existants (alerte « clé changée »).

**Briques disponibles** : AES-GCM (WebCrypto ; pointycastle, déjà utilisé pour les médias), `calculateSignature` / `verifySignature` (bibliothèque Signal web ; `Curve` de `libsignal_protocol_dart`).

### 2.3 La charge « trousseau »

Le trousseau voyage d'appareil à appareil dans une **enveloppe Signal à deux ordinaire**, déposée **hors fil** (`messageId: null`, ce que la route `POST /api/e2ee/enveloppes` permet déjà). Son clair a son propre préfixe, pour ne jamais être confondu avec un message :

```
"\u0000G1" + JSON {
  v: 1,
  type: "trousseau",
  convId,                       // doit être celui de l'enveloppe
  motif: "ACTIVATION" | "AJOUT" | "EXCLUSION" | "MANUEL" | "APPAREIL",
  versions: [ { n: 1, cle: "<base64>", creeLe: <ms> }, … ]
}
```

| Règle de lecture | Raison |
|---|---|
| `convId` du clair = `convId` de l'enveloppe | le serveur ne peut pas rattacher un trousseau à un autre groupe |
| l'expéditeur doit être **administrateur** du groupe, ou **le même compte** (ses autres appareils) | le serveur ne peut pas faire distribuer un trousseau par n'importe qui |
| une version déjà connue avec une **autre** clé est **refusée** et signalée | personne ne peut remplacer une clé existante |

Un ancien client ne connaît pas le préfixe `G1` : il ignore l'enveloppe. Il ne sait de toute façon pas lire un groupe chiffré.

---

## 3. Base de données (migrations additives uniquement)

### 3.1 `conv_participants` : l'appartenance

| Colonne | Type | Rôle |
|---|---|---|
| `est_membre` | `BOOLEAN NOT NULL DEFAULT true` | le champ `isMembre` : faux après un départ ou une exclusion |
| `quitte_le` | `TIMESTAMPTZ NULL` | date du départ |
| `exclu_par` | `UUID NULL` | l'administrateur qui a exclu (`NULL` = départ volontaire) |

- La ligne n'est **plus supprimée** au départ.
- Contrainte : `est_membre = false` ⇔ `quitte_le IS NOT NULL`.

### 3.2 `conversation`

| Colonne | Type | Rôle |
|---|---|---|
| `cle_version` | `INT NOT NULL DEFAULT 0` | version de clé **courante** ; 0 = jamais chiffré |

### 3.3 `e2ee_cle_versions` (nouvelle) : la numérotation, tenue par le serveur

| Colonne | Rôle |
|---|---|
| `conv_id`, `version` | clé primaire composée |
| `cree_par`, `cree_par_appareil` | qui l'a créée |
| `motif` | ACTIVATION, EXCLUSION, MANUEL |
| `cree_le` | date |

La création d'une version est **atomique** : `version = cle_version + 1` dans la même transaction. Deux créations simultanées : la seconde est refusée (409) et relit l'état.

### 3.4 `e2ee_messages_groupe` (nouvelle) : un chiffré par message

| Colonne | Rôle |
|---|---|
| `message_id` | clé primaire, référence `message` (suppression en cascade) |
| `conv_id`, `version`, `expediteur_appareil` | contexte |
| `corps` | le chiffré signé (§ 2.2), 64 Ko au plus |

Une **seule** ligne par message, quel que soit le nombre de membres. Il n'y a pas d'acquittement : le message reste lisible par les membres, comme un message ordinaire.

### 3.5 `e2ee_trousseaux` (nouvelle) : la copie de chaque membre, pour changer de téléphone

| Colonne | Rôle |
|---|---|
| `alanyaID`, `conv_id` | clé primaire composée |
| `corps` | le trousseau chiffré par la **clé maîtresse de l'archive personnelle** du membre (AES-GCM) |
| `maj_le` | dernière mise à jour |

- Le serveur ne peut pas le lire : la clé maîtresse ne sort jamais de l'appareil, elle s'ouvre avec le mot de passe (Argon2id).
- **Supprimée** par le serveur au départ ou à l'exclusion de la personne.
- Rangée **à part** de l'archive des messages, justement pour pouvoir être supprimée seule.

---

## 4. Serveur

### 4.1 Un seul contrôle d'appartenance

`estMembreActif(convId, userId)` dans `src/lib/appartenance.ts` (et son jumeau `.mjs` pour `ws-server.mjs`) : `est_membre = true`.

- Les **38 contrôles** actuels, dans 16 fichiers, passent tous par elle.
- Un test parcourt le code et refuse tout accès direct à `participant` hors de ce module, pour qu'aucun oubli ne survive.

### 4.2 Le périmètre

`src/lib/e2ee-perimetre.ts` :
- `TYPES_AUTORISES = [0, 2, 3, 4]` (liste blanche) ;
- **provisoire** : refus si un participant d'un tête-à-tête possède un compte développeur (`developer_accounts`), motif `EMETTEUR_API` ;
- les groupes ne sont plus refusés par principe.

### 4.3 Routes

| Route | Changement |
|---|---|
| `POST /api/conversations/:id/e2ee` | groupe : **administrateur seulement** ; crée la version 1 |
| `POST /api/conversations/:id/e2ee/versions` (nouvelle) | crée une version (exclusion, manuel) : administrateur ; corps `{ attendue: n }` |
| `POST …/members` | dans un groupe chiffré : refus si type non autorisé ou **aucune clé publiée** |
| `DELETE …/members` (exclusion) et `…/leave` | `est_membre = false`, suppression de `e2ee_trousseaux`, événement temps réel |
| `POST …/messages` | groupe chiffré : `{ chiffre: true, groupe: { version, corps } }` ; version = courante |
| `PATCH …/messages/:id` | modification : nouveau `corps` qui remplace l'ancien (délai de 2 h inchangé) |
| `GET …/messages` | rend `groupe: { version, expediteurAppareil, corps }` avec chaque message chiffré |
| `GET /api/e2ee/trousseaux/:convId` et `PUT` (nouvelles) | la copie personnelle du trousseau (§ 3.5) |
| `POST /api/e2ee/enveloppes` | plafond porté de **40 à 1 000** par dépôt (distribution d'un trousseau) ; en groupe, un **blocage** n'empêche plus de déposer chez les autres membres |

### 4.4 Événements temps réel

| Événement | Destinataires | Rôle |
|---|---|---|
| `membre_parti` | le partant et les membres | le partant efface son trousseau et le fil |
| `membre_ajoute` | les membres | message système « X a été ajouté par Y » |
| `cle_version` | les membres | « une nouvelle version existe » : les appareils attendent le trousseau |

---

## 5. Les parcours

### 5.1 Activation (administrateur)
1. Le serveur vérifie le périmètre (§ 4.2) et les clés de **tous** les membres.
2. Il pose `e2ee_actif`, crée la version 1.
3. L'appareil de l'administrateur tire **K1**, l'envoie (charge trousseau, motif ACTIVATION) à **chaque appareil de chaque membre**, y compris ses propres autres appareils.
4. Il range sa propre copie (`PUT /api/e2ee/trousseaux`).

### 5.2 Envoyer
1. L'appareil chiffre et signe avec la version **courante** (§ 2.2).
2. Un seul envoi : la ligne du message et son chiffré.
3. Les membres sont prévenus par l'événement `message` habituel ; ils lisent le chiffré avec le message.
4. Si l'appareil n'a pas la version courante : l'envoi est bloqué, avec le message « clé du groupe pas encore reçue ».

### 5.3 Recevoir
- Vérifier la signature (§ 2.2), puis déchiffrer.
- Ranger le clair dans le cache local et l'archive, comme en tête-à-tête.
- Un message d'une version inconnue reste « en attente de la clé du groupe ».

### 5.4 Ajouter un membre (administrateur)
1. Le serveur ajoute (§ 4.3), et refuse un type non autorisé ou un compte sans clés.
2. L'appareil de l'administrateur envoie **tout le trousseau** au nouveau membre (motif AJOUT).
3. Le nouveau membre lit tout l'historique depuis l'activation.

### 5.5 Départ volontaire
- Côté serveur : `est_membre = false`, suppression de sa copie serveur, événement `membre_parti`.
- Son application efface le trousseau local et le contenu déchiffré du groupe.
- Pas de nouvelle version.

### 5.6 Exclusion (administrateur)
- Comme 5.5, plus :
  1. l'appareil de l'administrateur réserve la version n + 1 ;
  2. il tire **Kn+1** et l'envoie aux membres restants (motif EXCLUSION) ;
  3. les messages suivants utilisent n + 1.

### 5.7 Changement manuel
Comme 5.6, sans exclusion (motif MANUEL).

### 5.8 Nouveau téléphone
1. Après connexion, l'archive personnelle s'ouvre avec le mot de passe (existant).
2. L'appareil récupère ses copies de trousseau (`GET /api/e2ee/trousseaux`).
3. **Repli** : un autre appareil du même compte, s'il est en ligne, renvoie le trousseau (motif APPAREIL).

### 5.9 Suppression pour tous, transfert, médias
- Suppression : la ligne du chiffré part avec le message.
- Transfert depuis un groupe : l'appareil renvoie le clair (`transfert_appareil`), comme aujourd'hui.
- Médias : le fichier est chiffré **une fois** avec sa propre clé ; seul le descripteur voyage dans le message de groupe.

---

## 6. Garanties et limites

| Garantie | Oui / Non |
|---|---|
| Le serveur ne lit ni les messages ni les clés | ✅ |
| Un membre ne peut pas écrire au nom d'un autre | ✅ (signature) |
| Le serveur ne peut pas déplacer ni réattribuer un message | ✅ (données associées) |
| Le serveur ne peut pas déclencher seul un partage d'historique | ✅ (seul un administrateur ou le même compte transmet le trousseau) |
| Un **exclu** ne lit rien de nouveau, même avec une fuite de la base | ✅ (nouvelle version) |
| Un membre **parti de lui-même** ne lit rien de nouveau | ⚠️ grâce au serveur (`est_membre`) et à l'effacement par son application ; **pas** contre une fuite de la base s'il a gardé une copie de la clé |
| Un appareil volé ne révèle pas le passé | ❌ il révèle tout l'historique : c'est le prix de l'historique partagé |
| L'archive résiste à un serveur piraté | ⚠️ elle dépend du mot de passe, qui transite à la connexion (décision assumée) |

---

## 7. Points à confirmer par le user

1. **Ajouter quelqu'un qui n'a pas de clés** (jamais ouvert une version à jour) : refusé, avec un message clair ? *(proposé : oui)*
2. **Un membre qui part** : son application efface aussi les messages **déjà déchiffrés** du groupe (« ne pas voir », selon ta demande), ou les garde comme WhatsApp ? *(proposé : effacer, conformément à `isMembre`)*
3. **Types autorisés en tête-à-tête** : la même liste que les groupes (0, 2, 3, 4) ? *(proposé : oui)*

---

## 8. Les lots

| Lot | Contenu | Validation |
|---|---|---|
| **1** | Module cryptographique commun : AES-GCM, signature, charge trousseau, **vecteurs croisés web ↔ mobile** | bancs : le web lit le mobile et l'inverse |
| **2** | Serveur : migrations, `estMembreActif` (38 contrôles), périmètre, routes, événements | tests, `tsc`, migration rejouée en `BEGIN … ROLLBACK` sur la vraie base |
| **3** | Mobile : envoyer, recevoir | tests, analyse |
| **4** | Web : envoyer, recevoir | construction, bancs navigateur |
| **5** | Trousseau : activation, ajout, exclusion, changement manuel | bancs à plusieurs appareils |
| **6** | Nouveau téléphone : copie personnelle et restauration | banc restauration |
| **7** | Interface : activation, bandeaux, messages système, vérification par membre | captures |
| **8** | Bancs de bout en bout, déploiement | — |
