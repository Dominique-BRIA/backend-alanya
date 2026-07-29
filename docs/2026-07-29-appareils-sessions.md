# Alanya — Registre des appareils, journal de connexion et révocation de session

**Date :** 29 juillet 2026
**Portée :** trois dépôts — `backend-alanya`, `alanya` (mobile Flutter), `STAGE-WEB` (client web)

Ce document décrit ce qui a été livré, fonctionnalité par fonctionnalité, avec
les routes, leurs entrées et leurs sorties. Les formes JSON sont relevées dans le
code, pas reconstituées de mémoire.

---

## Conventions communes

**Enveloppe des réponses.** Le succès renvoie l'objet **brut**, sans conteneur.
L'erreur est toujours de la forme :

```json
{ "error": { "message": "Texte lisible", "code": "CODE_MACHINE" } }
```

**Authentification.** Toutes les routes de ce document sauf `/api/auth/login` et
`/api/auth/setup` exigent l'en-tête `Authorization: Bearer <accessToken>`. À
défaut : `401 UNAUTHORIZED`, message « Token manquant ».

**Codes d'erreur rencontrés ici**

| Code | HTTP | Signification |
|---|---|---|
| `UNAUTHORIZED` | 401 | Jeton absent, invalide ou expiré |
| `NOT_FOUND` | 404 | Ressource inexistante **ou appartenant à autrui** |
| `BAD_ID` | 400 | Identifiant non entier ou négatif |
| `VALIDATION` | 422 | Corps de requête refusé par le schéma zod |

Le `404` sur une ressource appartenant à un autre compte est délibéré : répondre
`403` confirmerait que l'identifiant existe.

**Nommage.** Les colonnes physiques suivent le référentiel de l'équipe
(`cookies_WebID`, `is_online`, `create_at`, `os_system`). L'API, elle, expose du
camelCase (`cookiesWebId`, `isOnline`, `createAt`, `osSystem`) et convertit les
`SMALLINT` 0/1 en booléens. Les noms du référentiel restent en base, où ils ont
leur raison d'être.

---

## 1. Registre des appareils

**À quoi ça sert.** Répondre à « quels appareils ont accès à mon compte ? », et
permettre d'en couper un à distance. C'est un **registre** : une ligne par
appareil, mise à jour au fil de l'eau.

**Table `Appareil`** — `prisma/manual/2026-07_appareils.sql`

| Colonne | Type | Rôle |
|---|---|---|
| `appareilID` | `SERIAL` PK | Identifiant séquentiel |
| `cookies_WebID` | `VARCHAR(255)` | Identifiant stable produit par le client, conservé en `localStorage` (web) ou `SharedPreferences` (mobile) |
| `libelle` | `VARCHAR(45)` | Nom affiché, renommable |
| `is_online` | `SMALLINT` | 0 / 1 |
| `create_at` | `TIMESTAMPTZ` | Première inscription |
| `typeDevice` | `SMALLINT` | 0 = web, 1 = Android, 2 = iOS, 3 = bureau |
| `lastLogin` | `TIMESTAMPTZ` | Dernier signe de vie |
| `system` | `VARCHAR(45)` | « Windows 10/11 », « Android 13 »… |
| `alanyaID` | `UUID` FK → `users` | Propriétaire, suppression en cascade |
| `destroy` | `SMALLINT` | 1 = déconnecté à distance (effacement **logique**) |

Unicité sur le **couple** `(cookies_WebID, alanyaID)` : deux comptes utilisés
tour à tour dans le même navigateur gardent chacun leur entrée, au lieu de se
voler la ligne. Un seul index composite `(alanyaID, destroy, lastLogin DESC)` —
son préfixe gauche couvre les recherches sur `alanyaID` seul.

### `GET /api/appareils`

Les appareils du compte, actifs d'abord, puis du plus récemment vu au plus ancien.

**Entrée** — aucune.

**Sortie `200`**

```json
{
  "appareils": [
    {
      "appareilId": 3,
      "cookiesWebId": "b1f2…",
      "libelle": "Chrome sur Windows",
      "isOnline": true,
      "typeDevice": 0,
      "system": "Windows 10/11",
      "createAt": "2026-07-29T09:14:22.031Z",
      "lastLogin": "2026-07-29T11:02:47.880Z",
      "revoked": false
    }
  ]
}
```

`revoked` reflète `destroy = 1`. Les clients filtrent ces lignes : elles restent
en base pour l'historique mais n'ont pas leur place dans une liste intitulée
« connectés ».

### `POST /api/appareils`

Enregistre l'appareil courant, ou le rafraîchit s'il est déjà connu.
**Idempotent** — appelable à chaque démarrage sans créer de doublon.

**Entrée**

| Champ | Type | Obligatoire | Notes |
|---|---|---|---|
| `cookiesWebId` | `string` 8–255 | ✅ | Identifiant stable de l'appareil |
| `libelle` | `string` 1–45 | ❌ | Ignoré à la mise à jour s'il est absent |
| `typeDevice` | `int` 0–9 | ❌ | Défaut 0 |
| `system` | `string` ≤ 45 | ❌ | |
| `isOnline` | `int` 0–1 | ❌ | Défaut 1 |

**Sortie `200`** — `{ "appareil": { … } }`, même forme qu'au-dessus.

**Deux comportements à connaître.** Le libellé n'est remplacé que si le client
en fournit un : sans cette précaution, un appareil renommé « PC bureau »
redeviendrait « Chrome sur Windows » au démarrage suivant. Et une reconnexion
**réactive** un appareil précédemment déconnecté (`destroy` repasse à 0) : c'est
le même matériel, et l'utilisateur vient de s'y authentifier.

### `PUT /api/appareils/:appareilId`

Renommer, mettre à jour la présence. Toute mise à jour vaut signe de vie et
rafraîchit `lastLogin`.

**Entrée** — tous les champs facultatifs : `libelle` (1–45), `isOnline` (0–1),
`system` (≤ 45), `typeDevice` (0–9).

**Sortie `200`** — `{ "appareil": { … } }`

### `DELETE /api/appareils/:appareilId`

Déconnexion à distance. Effacement **logique** : la ligne survit avec
`destroy = 1`, pour garder trace de l'appareil et de sa dernière connexion.

**Entrée** — aucune.

**Sortie `200`**

```json
{
  "appareil": { "…": "…", "revoked": true },
  "sessionsRevoquees": 1
}
```

`sessionsRevoquees` à **0** signale que l'appareil a bien quitté la liste mais
qu'**aucun accès n'a pu être coupé** — cas d'une session ouverte avant
l'introduction du rattachement (voir § 3).

---

## 2. Journal des connexions

**À quoi ça sert.** Répondre à « quand et depuis où s'est-on connecté ? ». C'est
un **journal** : une ligne par connexion, jamais modifiée.

**Pourquoi ce n'est pas un doublon du registre.** Une connexion suspecte reste
visible au journal **même si l'appareil a disparu du registre** — précisément le
cas où l'on cherche. Effacer un appareil ne doit pas effacer son historique.

**Table `userAccess`** — créée lors de l'harmonisation, alimentée aujourd'hui.

| Colonne | Type | Rôle |
|---|---|---|
| `idLogin` | `BIGSERIAL` PK | |
| `alanyaID` | `UUID` FK → `users` | |
| `device` | `VARCHAR(255)` | « Chrome », « Application Alanya », `INDEFINI` |
| `ipAdress` | `VARCHAR(255)` | Via `clientIp()`, correct derrière Nginx |
| `os_system` | `VARCHAR(255)` | « Android 13 », « Windows 10/11 »… |
| `dateLogin` | `TIMESTAMPTZ` | |

Index ajouté : `(alanyaID, dateLogin DESC)` —
`prisma/manual/2026-07_user_access_index.sql`. Sans lui, lire l'historique d'un
compte obligeait à parcourir les connexions de **tous** les comptes. L'ancien
index sur la seule date est conservé : il servira la purge par ancienneté.

**Écriture.** Automatique, côté serveur, sur `POST /api/auth/login` et
`POST /api/auth/setup`. Aucun appel client n'est nécessaire.
`recordAccess()` n'échoue jamais bruyamment : un journal ne doit pas empêcher un
utilisateur légitime de se connecter.

### `GET /api/user-access`

**Entrée** — `?limit=N` facultatif : défaut 30, plafond 200, borné en silence.

**Aucun identifiant d'utilisateur en paramètre.** On ne renvoie jamais que ses
propres connexions : un journal d'accès révèle les habitudes, les horaires et la
localisation approximative d'une personne.

**Sortie `200`**

```json
{
  "acces": [
    {
      "idLogin": 42,
      "device": "Chrome",
      "ipAdress": "154.72.x.x",
      "osSystem": "Windows 10/11",
      "dateLogin": "2026-07-29T11:02:47.880Z"
    }
  ]
}
```

`INDEFINI` est la valeur du référentiel quand l'information manque. Les clients
ne l'affichent pas telle quelle.

---

## 3. Révocation réelle des sessions

**Le défaut corrigé.** `DELETE /api/appareils/:id` ne faisait que poser
`destroy = 1`. Aucun jeton n'était révoqué : l'appareil « déconnecté » gardait un
accès complet et disparaissait simplement de la liste. Un bouton
« Déconnecter » qui ne déconnecte pas donne une fausse assurance, précisément
dans la situation où l'on s'en sert.

**La cause.** `issueTokenPair(userId)` ne stockait que l'utilisateur. Rien ne
reliait un jeton de rafraîchissement à l'appareil qui l'avait obtenu — le serveur
ne *pouvait pas* savoir quelle session couper.

**Le socle** — `prisma/manual/2026-07_refresh_token_device.sql`

```sql
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS device_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_device_idx"
  ON refresh_tokens("userId", device_id);
```

### Routes modifiées

**`POST /api/auth/login`** et **`POST /api/auth/setup`** acceptent un champ
supplémentaire :

| Champ | Type | Obligatoire | Notes |
|---|---|---|---|
| `deviceId` | `string` 8–255 | ❌ | Même identifiant que `Appareil.cookies_WebID` |

Facultatif à dessein : un client plus ancien continue de se connecter, sa session
ne sera simplement pas révocable individuellement. Les sorties de ces routes sont
inchangées (`user`, `accessToken`, `refreshToken`).

### Le point décisif

`rotateRefreshToken` **reporte** désormais le `device_id` sur le couple émis.
Sans ce report, le lien serait perdu au premier rafraîchissement — donc au bout
de quinze minutes — et la session redeviendrait irrévocable.

### Limite structurelle

Le jeton d'accès est un **JWT sans état**, vérifié par sa signature : il reste
valide jusqu'à son expiration, **15 minutes** par défaut. Rafraîchir une page ne
ré-authentifie pas. La coupure en base n'est donc pas instantanée — d'où
l'événement temps réel ci-dessous.

Le supprimer imposerait une requête en base à chaque appel d'API.

### Événement WebSocket `session_revoked`

**Émission (client → serveur)** — sur la connexion authentifiée existante :

```json
{ "type": "session_revoked", "deviceId": "b1f2…" }
```

**Diffusion (serveur → clients)** — même charge utile, à **toutes** les sockets
du même compte. Chaque client compare l'identifiant reçu au sien ; seul celui qui
se reconnaît efface ses jetons.

**Pourquoi le client déclenche l'annonce, et non l'API.** L'API Next.js et
`ws-server.mjs` sont deux process PM2 distincts, sans canal entre eux. Le client,
lui, tient déjà une connexion authentifiée.

**Pourquoi c'est sans risque.** La diffusion est bornée à `ws.userId` : on ne peut
couper que ses propres appareils, ce qui est exactement le pouvoir recherché.

La révocation en base reste indispensable — elle couvre l'appareil **hors ligne**
au moment du clic, éjecté à son retour. L'événement ne fait qu'accélérer le cas
courant.

---

## 4. Appels multi-appareils

**Le symptôme.** Compte ouvert sur mobile et web : décrocher sur le web laissait
le téléphone sonner indéfiniment. L'inverse fonctionnait — le client web gérait
déjà ce cas, pas le mobile.

**La cause.** Le serveur diffusait bien l'information (`sendTo` atteint **toutes**
les sockets d'un utilisateur). Mais le `call_state` porte **notre propre
identifiant** — c'est bien nous qui avons décroché, depuis un autre appareil. Les
clients y voyaient l'écho de leur propre action et sortaient aussitôt.

**Corrigé sur les trois états** `joined`/`accepted`, `declined`/`left`,
`rejected`/`ended` : le défaut dépassait le symptôme signalé — refuser un appel
produisait le même effet.

**Garde-fou commun** : on ne nettoie que si l'appel sonne encore chez nous
**et** qu'il n'est pas celui qu'on vient d'accepter. Le nettoyage reste local —
envoyer quoi que ce soit au serveur raccrocherait l'appel que l'autre appareil
vient de prendre.

**Côté push (`ws-server.mjs`)**, pour l'appareil dont l'application est **fermée** :

| État | Destinataires du push d'annulation |
|---|---|
| `ended`, `rejected`, `declined`, `cancelled` | **Tous** les participants, y compris les autres appareils de celui qui agit |
| `joined`, `accepted` | **Uniquement** les autres appareils du décrocheur |

Prévenir les autres participants d'un décrochage serait un contresens : pour eux,
l'appel commence. L'ancien code sautait explicitement les appareils de l'émetteur
(`if (uid === ws.userId) continue`), d'où un téléphone qui continuait de sonner
quand on refusait depuis le web.

---

## 5. Alanya ID

Renommage de « Numéro Alanya » en « Alanya ID » et formatage visuel.

**Découpage retenu** — `formatAlanyaId()`

| Longueur | Format |
|---|---|
| 3 | `xxx` |
| 4 | `xx xx` |
| 6 | `xxx xxx` |
| 8 | `xx xx xx xx` |
| 10 | `x xxx xxx xxx` |
| autre | repli 2 par 2 |

**Constat sur pièces** : le serveur n'émet que des identifiants à **8 chiffres**
(`generateUniquePublicNumber`), la colonne est en `VarChar(8)` et les endpoints
n'acceptent que 6 ou 8. Les cas 3, 4 et 10 sont donc **injoignables** avec des
données réelles — conservés pour ne pas casser l'affichage si ces longueurs
arrivaient un jour, ce qui exigerait une migration de colonne.

`stripAlanyaId()` retire **tous** les non-chiffres, pas seulement les espaces :
un « 67-64-15-99 » collé partait sinon au serveur avec ses tirets. Il est appelé
**avant** validation sur tous les champs de saisie — sans quoi coller un ID
formaté le faisait rejeter comme invalide.

Traductions alignées dans les **8 langues**. Le décompte « (6 chiffres) » a
disparu des libellés de connexion : il était faux.

---

## 6. Infrastructure

**Migration hors de Neon.** La base tourne désormais sur PostgreSQL 18 installé
sur le VPS — base `alanya`, rôle `alanyavox`, connexion locale sans SSL.

**Leçon retenue :** un `curl` qui renvoie `BAD_CREDENTIALS` prouve qu'**une** base
répond, pas laquelle. Pour vérifier une bascule, lire une table qui n'existe que
localement, ou `grep '^DATABASE_URL' .env`.

**Sauvegarde.** `~/backups/backup-alanya.sh`, lancé par cron chaque nuit à 3 h,
`pg_dump` compressé, rétention 14 jours, journal dans `~/backups/backup.log`.

**Angle mort connu :** les **médias** ne sont sauvegardés nulle part. Ils sont sur
le disque du VPS (`~/backend-alanya/storage/media`), plus sur Backblaze B2. Une
perte disque emporterait toutes les photos et vocaux, et les messages restaurés
pointeraient vers des fichiers disparus.

**Script de déploiement.** `scripts/apply-manual-sql.sh` applique les fichiers de
`prisma/manual/` d'un coup. Ils ne sont joués ni par `npm run build`, ni par
`prisma generate`, ni par `git pull` — l'étape s'oublie, et l'a été deux fois.
Tous portent `IF NOT EXISTS` : les rejouer est sans effet.

### Déploiement complet

```bash
cd ~/backend-alanya \
  && git pull origin backup/pre-harmonisation-2026-07-24 \
  && bash scripts/apply-manual-sql.sh \
  && npm install \
  && npx prisma generate \
  && npm run build \
  && pm2 restart alanya-api alanya-ws \
  && pm2 save
```

`alanya-ws` doit redémarrer aussi : c'est lui qui porte les gestionnaires
WebSocket.

---

## 7. Écrans livrés

| Écran | Mobile | Web |
|---|---|---|
| Appareils connectés | Menu ⋮ de l'accueil | Réglages → Sécurité → « Sessions actives » |
| Historique de connexion | Paramètres → Sécurité | Réglages → Sécurité |

La carte « Sessions actives » du web affichait auparavant **trois lignes écrites
en dur** — les mêmes pour tout le monde, à chaque ouverture — et son bouton
« Déconnecter » se contentait d'afficher un message.

**Un écart assumé :** la colonne « localisation » montrait une ville. Le
référentiel ne stocke ni IP ni géolocalisation pour un *appareil* ; la ligne
affiche donc le système d'exploitation. Une vraie localisation supposerait de
croiser l'IP du journal `userAccess` avec un service tiers — le seul des choix
possibles qui envoie l'IP des utilisateurs à l'extérieur.

---

## 8. Commits du jour

**`backend-alanya`** (`backup/pre-harmonisation-2026-07-24`)

| | |
|---|---|
| `01c6f15` | Appels : annuler la notification push sur les autres appareils |
| `956de6c` | Appareils (lot 1) : table `Appareil` et modèle Prisma |
| `f27b77b` | Appareils (lot 2) : routes REST du registre |
| `fbcf10d` | `userAccess` : journal des connexions |
| `c6f8174` | Script d'application des SQL manuels |
| `6acdb81` | Déconnexion d'appareil : révoquer réellement la session |
| `6369d76` | Déconnexion immédiate : événement `session_revoked` |

**`alanya`** (`arena/019fa167-alanya`)

| | |
|---|---|
| `0fe8a51` | Nouveau logo, en app et en icône |
| `e5356f0` | Appels : couper la sonnerie quand un autre appareil décroche |
| `11ab26f` | Appareils : inscription et écran « Appareils connectés » |
| `69f8b51` | Historique de connexion : écran mobile |
| `318a9ee` | Logo et icône : recentrage, blanc intérieur |
| `f30dd2d` | Logo : blanc intérieur rétabli |
| `42034ed` | Connexion : transmettre l'identifiant d'appareil |
| `99ad4c6` | Déconnexion immédiate : `session_revoked` |

**`STAGE-WEB`** (`integration-backend-alanya`)

| | |
|---|---|
| `2a2e647` | Appels : couper la sonnerie quand un autre appareil refuse |
| `5adc098` | Le client web s'inscrit au registre |
| `778fce3` | Sessions actives : de vraies données à la place de la maquette |
| `6c2ddd5` | Historique de connexion : nouvelle carte |
| `90e445a` | Connexion : transmettre l'identifiant d'appareil |
| `4284cf5` | Déconnexion immédiate : `session_revoked` |

---

## 9. Ce qui reste ouvert

**Sauvegarde des médias** — le seul angle mort de la stratégie de sauvegarde.
Volume non mesuré ; la méthode (archive complète ou miroir incrémental) en dépend.

**Mot de passe Neon** — il a fuité en clair et n'a pas été réinitialisé. Plus rien
n'en dépend depuis la migration : l'opération est désormais sans risque.

**Purge du journal `userAccess`** — un journal ne fait que grossir. L'index sur
`dateLogin` est conservé pour la rendre efficace.

**Copie hors site des sauvegardes** — les dumps vivent sur le disque qu'ils
protègent. Ils couvrent la fausse manœuvre et le bug, pas la perte du VPS.

**Code mort côté web** — `src/indexedDB/` et les trois hooks `useLocalFirst*` ne
sont utilisés par aucun composant. Vestige du prototype, remplacé par
`src/services/*` et `lib/api-client`.

**`chat_screen.dart.bak`** — sauvegarde manuelle versionnée dans le dépôt mobile,
qui pollue toutes les recherches de code sur le fil de discussion.
