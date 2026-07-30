# Écarts entre le dépôt et le schéma Prisma du référentiel équipe

**Date :** 30 juillet 2026 (mis à jour en fin de journée)
**Fichier de référence :** `schema(1).prisma` transmis le 29/07/2026
**Comparé à :** `prisma/schema.prisma`, branche `backup/pre-harmonisation-2026-07-24`

La base est **partagée entre plusieurs développeurs**. Chaque écart entre le
schéma du dépôt et le référentiel est donc une source de surprise pour les
autres, pas seulement une dette interne. Tout ce qui pouvait être aligné sans
casser la production l'a été.

Ce document liste ce qui reste, et pourquoi.

---

## 1. Aligné

### 1.1 Les 13 modèles du volet organisation

| Modèle | Table |
|---|---|
| `Ville` | `ville` |
| `AdminRoot` | `adminroot` |
| `PrixAbonnement` | `prixabonnement` |
| `Abonnement` | `abonnement` |
| `Company` | `company` |
| `Admin` | `admin` |
| `Agence` | `agence` |
| `Service` | `service` |
| `Fonction` | `fonction` |
| `GestionCompany` | `gestioncompany` |
| `CenterCom` | `centercom` |
| `Center` | `center` |
| `AccesAdmin` | `accesadmin` |

### 1.2 Colonnes ajoutées

`users.idcompany`, `users.appareil_total`, `users.actif`, `users.mobile`,
`pays.libelleAnglais`, `callHistory.transmission`.

### 1.3 Longueurs de colonnes

| Colonne | Avant | Après | Maximum constaté |
|---|---|---|---|
| `users.pseudo` | `VARCHAR(100)` | `VARCHAR(50)` | 17 |
| `users.alanyaPhone` | `VARCHAR(8)` | `VARCHAR(20)` | — |
| `users.email` | `TEXT` | `VARCHAR(100)` | 49 |
| `users.password` | `TEXT` | `VARCHAR(255)` | 60 (bcrypt) |
| `users.avatar_url` | `VARCHAR(2048)` | `TEXT` | **1955** |
| `pays.libelle` | `VARCHAR(200)` | `VARCHAR(100)` | 19 |

`avatar_url` méritait l'élargissement bien plus qu'un alignement cosmétique :
la plus longue valeur en base occupait déjà 96 % de la limite.

### 1.4 Valeurs par défaut

`users.updatedAt` → `now()` · `pays.prefix` → `''` · `pays.timeZone` →
`'Africa/Dakar'` · `pays.decalageHoraire` → `0` · `meeting.start_time` →
`now()` · `meeting.duree` → `0` · `meeting.objet` → `'Réunion'` ·
`meeting.room` → `'default-room'` · `meeting.type_media` → `1`.

Un `DEFAULT` ne modifie aucune ligne existante : il ne s'applique qu'aux
insertions futures qui omettent la colonne.

### 1.5 Noms de champs Prisma

`center_alanyaID`, `users_alanyaID`, `in_call`, `date_at`, `acces_at`,
`idaccesAdmin`, `created_at`, et les relations en majuscule (`Companies`,
`Agences`, `Fonctions`, `Admins`, `CenterComs`, `AccesAdmins`, `Abonnements`,
`Gestions`, `Users`, `Services`, `Centers`, `GestionCompany`).

Aucune migration : les noms **physiques** étaient déjà ceux du référentiel,
obtenus par `@map`. Seuls changent les noms exposés par le client TypeScript.

### 1.6 Validations applicatives réalignées

Trois rétrécissements de colonnes auraient produit des **erreurs 500** au lieu
de messages clairs, parce que la validation `zod` était plus permissive que la
base :

| Schéma | Avant | Après |
|---|---|---|
| `setupSchema.pseudo` | `max(100)` | `max(50)` |
| `updateProfileSchema.pseudo` | `max(100)` | `max(50)` |
| `emailSchema` | aucune borne | `max(100)` |

C'est le piège récurrent de ce genre d'alignement : rétrécir une colonne sans
toucher à la validation déplace simplement l'erreur, de l'utilisateur vers la
base.

---

## 2. 🔴 Écarts volontaires — les reprendre casserait la production

### 2.1 `Message` : clé primaire `UUID` → `BigInt`

Le référentiel remplace `msgID UUID` par `msgID BigInt @default(autoincrement())`.

Ce n'est pas un renommage mais un changement de type sur la clé primaire d'une
table qui contient tout l'historique des messages. Il se propage à quatre tables
enfants dont la colonne `message_id` devrait changer en même temps :
`message_stars`, `message_reactions`, `message_hides`, `media_files`.

Une telle migration demande une table de correspondance UUID → BigInt, une
reprise de chaque table enfant, et une coupure de service.

### 2.2 Disparition de `Message.expires_at`

Cette colonne porte les **messages éphémères** (lot 2.6, en production). Le code
s'en sert en quatre points de `src/app/api/conversations/[id]/messages/route.ts`
(lignes 52, 107, 139, 149) et la purge périodique du serveur WebSocket s'y
appuie. La retirer désactiverait silencieusement la fonctionnalité.

### 2.3 Disparition de `Message.deletedAt`

Remplacée par le couple `isDeleted` / `deletedForID`. La suppression « pour
tous » repose sur `deletedAt` — **18 occurrences**. Migrer est possible, mais
c'est une réécriture de la logique de suppression.

### 2.4 `users.alanyaPhone` perd sa contrainte `@unique`

Le référentiel déclare la colonne sans `@unique`. **Deux comptes pourraient
alors porter le même Alanya ID.**

La longueur `VARCHAR(20)` a été reprise, l'unicité **non**. C'est l'écart le
plus probablement issu d'un oubli.

### 2.5 `users.alanyaPhone` prend `@default("100000")`

Non repris, et pas seulement par prudence : **poser une valeur par défaut sur
une colonne unique est un piège**. La première insertion qui omet le champ
obtient `100000` ; la deuxième viole la contrainte d'unicité et échoue avec un
message obscur.

Le code fournit toujours la valeur (`src/lib/publicNumber.ts`), donc ce défaut
serait inerte chez nous — mais sur une base partagée, il tendrait un piège aux
autres.

### 2.6 Horodatages de `message` en `Timestamp(6)`

Le référentiel passe `sendAt`, `readAt` et `editedAt` de `Timestamptz` à
`Timestamp(6)`, **sans fuseau horaire**. L'application sert des utilisateurs sur
plusieurs fuseaux ; l'ordre des messages deviendrait incorrect dès qu'un client
et le serveur ne sont pas dans la même zone.

### 2.7 `message` perd ses deux index

Le référentiel ne déclare plus `@@index([convId, createdAt])` ni
`@@index([senderId])` — exactement les index qui servent le chargement d'une
conversation.

### 2.8 Renommages en cascade dans le code

| Actuel | Référentiel | Occurrences dans `src/` |
|---|---|---|
| `convId` | `conversationID` | **190** |
| `messageId` (type) | `BigInt` | 70 |
| `senderId` | `senderID` | 29 |
| `deletedAt` | `isDeleted` / `deletedForID` | 18 |
| `replyToId` | `replyToID` | 14 |

Environ **340 références**, réparties sur l'API, le serveur WebSocket et les
trois clients.

### 2.9 Suppression de `users.emailVerified`

Commentée « à supprimer » dans le référentiel, mais encore utilisée par le flux
de vérification d'adresse.

### 2.10 `Meeting.idOrganiser` et `MeetingParticipant.IDparticipant` deviennent nullables

Rendre une colonne nullable est sans risque pour les données, mais c'est une
régression de sens : une réunion sans organisateur, ou un participant sans
utilisateur, ne veulent rien dire. Le type TypeScript passerait de `string` à
`string | null`, forçant des vérifications de nullité partout pour un cas qui ne
devrait pas exister.

### 2.11 `MeetingParticipant` perd son `@@unique([idMeeting, IDparticipant])`

Le référentiel ne la déclare pas. Sans elle, **le même utilisateur pourrait être
inscrit deux fois à la même réunion**.

Le référentiel ajoute à la place un `@@index([idMeeting])` — qui serait de toute
façon **redondant** : le préfixe gauche de la contrainte d'unicité existante
couvre déjà les recherches sur `idMeeting` seul.

---

## 3. Ce qu'il reste à décider

Il ne reste **aucun écart sans risque**. Tout ce qui subsiste relève de la
section 2, et se répartit en deux familles.

**Trois points ressemblent à des oublis** plutôt qu'à des décisions, et méritent
une question à l'équipe :

- **2.4** — la perte de l'unicité sur `alanyaPhone`
- **2.2** — la disparition de `expires_at`
- **2.6** — la perte du fuseau horaire sur les horodatages de `message`

**Le reste est un chantier réel** : la refonte de `Message` (2.1, 2.3, 2.7,
2.8). À planifier avec une sauvegarde fraîche, une fenêtre de coupure et un
déploiement coordonné des trois clients. Ce n'est pas quelque chose qui se
glisse dans un lot courant.

---

## 4. Migrations correspondantes

| Fichier | Contenu |
|---|---|
| `prisma/manual/2026-07_organisation.sql` | les 13 tables + `users.idcompany` |
| `prisma/manual/2026-07_rapport_chat.sql` | renommages centre d'appels, `rapportChat`, `docRapport` |
| `prisma/manual/2026-07_champs_referentiel.sql` | `actif`, `mobile`, `libelleAnglais`, `transmission` |
| `prisma/manual/2026-07_longueurs_colonnes.sql` | `pseudo` → 50, `alanyaPhone` → 20 |
| `prisma/manual/2026-07_alignement_referentiel.sql` | `email`, `password`, `avatar_url`, et les 9 valeurs par défaut |

Toutes sont idempotentes et rejouées à chaque déploiement par
`scripts/apply-manual-sql.sh`. Les trois rétrécissements de colonnes
revérifient les données à l'exécution et lèvent une exception lisible plutôt que
de laisser le déploiement s'interrompre sans explication.
