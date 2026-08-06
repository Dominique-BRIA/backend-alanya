# Réponse au schéma du 05/08/2026

Document destiné à l'équipe, à lire avec `prisma/schema.prisma`.

Le schéma reçu le 05/08 a été repris **en grande partie**. Ce qui ne l'a pas
été figure ci-dessous avec sa raison — dans tous les cas, une divergence
constatée entre le schéma proposé et l'état réel de la base de production.

Base de référence : PostgreSQL 18 sur `alanyavox.com`, relevée le 05/08/2026
(1 337 appels, 50 comptes, 138 appareils).

---

## 1. Repris intégralement

**Facturation** — `Root`, `Facture`, `FactureLigne`, `JustificatifPaiement`,
avec `FactureStatut` et `JustificatifStatut`. Les quatre tables n'existaient
pas ; elles sont créées telles que décrites.

**`company`** — `numero_court` et `isDelete` ajoutées.

**`prixabonnement.type`** — ajoutée (0 agent, 1 centre d'appel, 2 numéro court).

**Assouplissements** — `bordereauAgent`, `rapportChat`, `commentaire` passent de
`CASCADE` à `SET NULL`, colonnes portantes rendues nullables. `transferer`
gagne `idAgent` et `commentaire`. Six index retirés (`accesadmin` ×2,
`center` ×3, `centercom`).

**Nommage** — `Appareil.nomAgent` → `agent`, `customerChat.customerID` →
`AlanyaID`, `Appareil.idAgent` → champ `alanyaId`. Ces trois renommages
annulent ceux que nous avions faits le 29/07 ; nous nous alignons sur vous.

**Relations** — `Service` (×4), `Agence.rapports`, `User.rapportsAgent`,
`Commentaire.bordereau`, `TypeCompany.Companies`, `CustomerChat.rapports`.

---

## 2. Non repris — divergences avec la base réelle

### 2.1 `Message.msgID` : la colonne est un `uuid`, pas un `BigInt`

Le schéma déclare :

```prisma
model Message {
  msgID BigInt @id @default(autoincrement())
```

La colonne réelle :

```
message.msgID : uuid
```

Idem pour `message_reactions.message_id` et `message_stars.message_id`, tous
deux en `uuid`, déclarés en `BigInt`.

Ce n'est pas un renommage : c'est un changement de **type de clé primaire** sur
une table de production, qui imposerait de réécrire toutes les clés de
`message` et les trois tables qui la référencent. **Nous ne l'avons pas
appliqué.**

À vérifier de votre côté : si ce schéma est généré depuis votre propre
instance, nos deux bases ont déjà divergé sur une clé primaire.

### 2.2 `Message.conversationID` : le `@map` désigne une colonne inexistante

```prisma
conversationID String? @map("conversID")
```

La colonne réelle s'appelle **`conversationID`**, pas `conversID`. Prisma
chercherait une colonne absente. Nous avons gardé notre déclaration, qui
pointe correctement.

### 2.3 `Call.conversationID` : la colonne s'appelle `convId`

```prisma
model Call {
  conversationID String? @db.Uuid   // aucune @map
```

Dans `calls`, la colonne est **`convId`**. Renommer toucherait 27 fichiers du
backend. Nous n'avons pas suivi — à arbitrer ensemble si vous souhaitez
uniformiser.

### 2.4 `CallStatus` : `NO_ANSWER` et `BUSY` manquent

Le type déclaré ne contient que `RINGING, ONGOING, ENDED, MISSED, REJECTED`.
La base en production contient :

```
RINGING, ONGOING, ENDED, MISSED, REJECTED, NO_ANSWER, BUSY
```

Ces deux valeurs ont été ajoutées le 03/08 pour distinguer « personne n'a
décroché » de « le correspondant était en ligne » — sans elles, le serveur
écrivait `ENDED` dans les deux cas, la même valeur qu'un appel abouti, et le
client affichait régulièrement le mauvais libellé. Elles sont utilisées à 21
endroits du code.

**PostgreSQL ne sait pas retirer une valeur d'un enum** : il faudrait recréer
le type et réécrire toutes les colonnes qui l'utilisent, sur des données de
production. Merci de les intégrer de votre côté.

### 2.5 `User` : `emailVerified` et `resetPasswordExpires` retirés

Ces deux colonnes existent en base et servent à l'authentification (6 usages).
Nous les avons conservées.

### 2.6 `User.publicNumber` : l'unicité est retirée

```prisma
publicNumber String @default("100000") @map("alanyaPhone")
```

La contrainte `UNIQUE` existe bien sur `users.alanyaPhone`. La retirer
permettrait à deux comptes de partager le même Alanya ID, et le défaut
`"100000"` en attribuerait un identique à tout compte créé sans valeur.
Conservée telle quelle.

### 2.7 `company.idtypecompany` en minuscules

```prisma
idTypeCompany Int? @map("idtypecompany")
```

La colonne réelle est **`idTypeCompany`**, en camelCase — elle suit celle
qu'elle référence, `typeCompany.idTypeCompany`. PostgreSQL distingue la casse
des identifiants entre guillemets : ce `@map` chercherait une colonne
inexistante. Conservé en camelCase.

### 2.8 Suppressions de colonnes non appliquées

`prixabonnement.description`, `rapportChat.mobile` et `rapportChat.type` sont
retirées par le schéma. Les deux dernières sont vides aujourd'hui, mais une
colonne supprimée ne se récupère pas. Nous les avons gardées — à confirmer
si vous voulez qu'elles disparaissent.

---

## 3. Un point de méthode

`rapportChat.subject` passe de `VARCHAR(200)` nullable à `VARCHAR(150)` **non
nul**, et `commentaire.content` devient non nul. Nous les avons appliqués
**parce que ces tables sont vides** chez nous.

Sur une base alimentée, le premier tronque et le second échoue. Si votre
instance contient déjà des rapports, ces deux changements demandent une reprise
préalable des données.
