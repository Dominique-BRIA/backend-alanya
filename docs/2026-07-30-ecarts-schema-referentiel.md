# Écarts entre le dépôt et le schéma Prisma du référentiel équipe

**Date :** 30 juillet 2026
**Fichier de référence :** `schema(1).prisma` transmis le 29/07/2026
**Comparé à :** `prisma/schema.prisma`, branche `backup/pre-harmonisation-2026-07-24`

Ce document liste ce qui **n'a pas été repris** du fichier de l'équipe, et
pourquoi. Chaque écart est classé selon son risque, pas selon sa taille.

---

## 1. Ce qui a été intégré

Pour situer le reste : les **13 modèles** du volet organisation sont tous en
place, ainsi que les colonnes qui les accompagnent.

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

Colonnes ajoutées à des tables existantes : `users.idcompany`,
`users.appareil_total`, `users.actif`, `users.mobile`, `pays.libelleAnglais`,
`callHistory.transmission`.

Longueurs alignées : `users.pseudo` en `VARCHAR(50)`, `users.alanyaPhone` en
`VARCHAR(20)`.

Noms de champs Prisma alignés sur le référentiel : `center_alanyaID`,
`users_alanyaID`, `in_call`, `date_at`, `acces_at`, `idaccesAdmin`,
`created_at`, et les relations en majuscule (`Companies`, `Agences`,
`Fonctions`, `Admins`, `CenterComs`, `AccesAdmins`, `Abonnements`, `Gestions`,
`Users`, `Services`, `Centers`, `GestionCompany`).

---

## 2. 🔴 Écarts volontaires — les reprendre casserait la production

### 2.1 `Message` : clé primaire `UUID` → `BigInt`

Le référentiel remplace `msgID UUID` par `msgID BigInt @default(autoincrement())`.

**Pourquoi c'est bloquant.** Ce n'est pas un renommage mais un changement de
type sur la clé primaire d'une table qui contient tout l'historique des
messages. Il se propage à quatre tables enfants dont la colonne `message_id`
devrait changer de type en même temps :

- `message_stars`
- `message_reactions`
- `message_hides`
- `media_files`

Une telle migration demande une table de correspondance UUID → BigInt, une
reprise de chaque table enfant, et une coupure de service. Ce n'est pas un lot
de quelques heures.

### 2.2 Disparition de `Message.expires_at`

Cette colonne porte les **messages éphémères** (lot 2.6, livré et en
production). Le code s'en sert en quatre points de
`src/app/api/conversations/[id]/messages/route.ts` (lignes 52, 107, 139, 149) et
la purge périodique du serveur WebSocket s'y appuie.

La retirer désactiverait silencieusement la fonctionnalité.

### 2.3 Disparition de `Message.deletedAt`

Remplacée dans le référentiel par le couple `isDeleted` / `deletedForID`. La
suppression « pour tous » repose sur `deletedAt` — **18 occurrences** dans le
code.

Migrer est possible, mais c'est une réécriture de la logique de suppression, pas
un changement de colonne.

### 2.4 `users.alanyaPhone` perd sa contrainte `@unique`

Le référentiel déclare :

```prisma
publicNumber String @default("100000") @map("alanyaPhone") @db.VarChar(20)
```

Sans `@unique`. **Deux comptes pourraient alors porter le même Alanya ID.**

La longueur `VARCHAR(20)` a été reprise, l'unicité **non**. C'est l'écart le
plus probable d'un oubli : personne ne retire volontairement l'unicité d'un
identifiant de compte.

À noter : `src/lib/publicNumber.ts` génère toujours 8 chiffres et
`src/lib/validation.ts` n'accepte que 6 ou 8. L'élargissement de la colonne ne
change donc rien au comportement.

### 2.5 Horodatages de `message` en `Timestamp(6)`

Le référentiel passe `sendAt`, `readAt` et `editedAt` de `Timestamptz` à
`Timestamp(6)`, **sans fuseau horaire**.

L'application sert des utilisateurs sur plusieurs fuseaux. Perdre le fuseau
rendrait l'ordre des messages incorrect dès qu'un client et le serveur ne sont
pas dans la même zone.

### 2.6 `message` perd ses deux index

Le référentiel ne déclare plus `@@index([convId, createdAt])` ni
`@@index([senderId])`.

Ce sont exactement les index qui servent le chargement d'une conversation. Les
retirer transformerait chaque ouverture de discussion en parcours complet de la
table.

### 2.7 Renommages en cascade dans le code

| Actuel | Référentiel | Occurrences dans `src/` |
|---|---|---|
| `convId` | `conversationID` | **190** |
| `messageId` (type) | `BigInt` | 70 |
| `senderId` | `senderID` | 29 |
| `deletedAt` | `isDeleted` / `deletedForID` | 18 |
| `replyToId` | `replyToID` | 14 |

Environ **340 références** à reprendre, réparties sur l'API, le serveur
WebSocket et les trois clients.

### 2.8 Suppression de `users.emailVerified`

Commentée « à supprimer » dans le référentiel, mais encore utilisée par le flux
de vérification d'adresse.

### 2.9 `users.pseudo` de `VARCHAR(100)` à `VARCHAR(50)`

**Cet écart a été comblé le 30/07/2026**, après vérification qu'aucun pseudo ne
dépassait 50 caractères (maximum constaté : 17). Mentionné ici parce qu'il
illustre la précaution nécessaire : un rétrécissement de colonne échoue si une
seule valeur dépasse, et arrête le déploiement.

La validation `zod` a dû être alignée dans le même lot — elle acceptait encore
100 caractères, ce qui aurait produit une erreur 500 au lieu d'un message clair.

---

## 3. 🟡 Écarts restants, sans risque

Ces points n'ont pas été repris parce qu'ils n'apportaient rien pour l'instant.
Ils peuvent l'être à tout moment, en quelques minutes.

| Écart | Modèle | Nature |
|---|---|---|
| Défauts sur `objet`, `room`, `duree`, `type_media` | `Meeting` | cosmétique, aucun effet sur les données existantes |
| `avatarUrl` en `Text` au lieu de `VarChar(2048)` | `User` | élargissement, sans risque |
| `updatedAt` avec `@default(now())` | `User` | sans effet, la colonne est déjà remplie à chaque écriture |
| `email` en `VarChar(100)` | `User` | ⚠️ rétrécissement — à vérifier avant, comme pour `pseudo` |
| `passwordHash` en `VarChar(255)` | `User` | sans effet, un hash bcrypt fait 60 caractères |
| `libelle` de `VarChar(200)` à `(100)` | `Pays` | ⚠️ rétrécissement — à vérifier avant |

---

## 4. Recommandation

Les points **2.4** (perte de l'unicité sur `alanyaPhone`), **2.2** (disparition
de `expires_at`) et **2.5** (perte du fuseau horaire) ressemblent à des oublis
plutôt qu'à des décisions. Ils méritent une question à l'équipe avant que le
schéma ne soit régénéré et que l'écart ne se creuse.

Le reste — la refonte de `Message` — est un chantier réel, à planifier avec une
sauvegarde fraîche, une fenêtre de coupure et un déploiement coordonné des trois
clients. Ce n'est pas quelque chose qui se glisse dans un lot courant.
