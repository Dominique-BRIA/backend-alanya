# Chapitre 33 — Le serveur d'un groupe chiffré : partir sans disparaître

> **Où nous en sommes.** 09/10/2026. Le chapitre 32 a prouvé la brique
> cryptographique (lot 1). Ce chapitre couvre le **lot 2** : tout ce que le
> **serveur** doit savoir faire pour qu'un groupe soit chiffré, sans jamais
> pouvoir lire ce qui s'y dit. Aucun écran encore : les applications viendront
> aux lots 3 à 7.
>
> Migration `prisma/manual/2026-10_e2ee_groupes.sql`, module
> `src/lib/appartenance.mjs`, périmètre `src/lib/e2ee-perimetre.ts`, charge
> `src/lib/e2ee-groupe-charge.ts`, annonce `src/lib/e2ee-annonce.ts`, routes
> `conversations/[id]/e2ee`, `…/e2ee/versions`, `e2ee/trousseaux`. Bancs
> `scripts/appartenance-banc.mjs`, `perimetre-banc.mjs`,
> `groupe-chiffre-banc.mjs`, garde `scripts/appartenance-garde.mjs`.
> Commits `2091c41` (2a), `15d6d23` (2b), `bfde0ff` (2c).

---

## 1. Ce que le serveur fait encore, quand il ne lit plus rien

Le serveur ne voit plus le texte. Il garde pourtant trois rôles, et ce sont
eux que ce lot construit :

| Rôle | Pourquoi lui seul peut le tenir |
|---|---|
| **qui est membre** | c'est lui qui sert les messages : un ancien membre ne doit plus rien recevoir |
| **le numéro de la clé** | deux administrateurs ne doivent pas créer deux clés sous le même numéro |
| **le transport** | les chiffrés, les trousseaux, les sonnettes |

Il ne vérifie **ni la signature ni le chiffré** : il n'a pas la clé. C'est le
destinataire qui vérifie (chapitre 32).

## 2. `isMembre` : une ligne qui reste

### Avant

Quitter un groupe **supprimait** la ligne de `conv_participants`.
Conséquence : plus aucune trace de qui avait eu accès, et rien pour dire
« cette personne est partie le… ».

### Maintenant

La ligne reste, avec trois colonnes :

| Colonne | Sens |
|---|---|
| `est_membre` | faux après un départ ou une exclusion |
| `quitte_le` | la date |
| `exclu_par` | l'administrateur qui a exclu (vide = départ volontaire) |

Une contrainte en base refuse une ligne incohérente (« pas membre » sans date).

### Le danger que ça crée

« Avoir une ligne » ne veut **plus** dire « être membre ».

Il y avait **38 lectures** de l'appartenance, dans **16 fichiers**. Chacune qui
oublierait le filtre servirait un ancien membre : messages, enveloppes,
présence, non-lus, notifications.

### La parade : un filtre unique, et un garde-fou

1. Le filtre s'écrit d'une seule façon : `...MEMBRE_ACTIF`
   (`src/lib/appartenance.mjs`).
2. Un script parcourt **tout** le code et refuse une lecture de `participant`
   sans ce filtre : `node scripts/appartenance-garde.mjs`.

Le script a tout de suite servi : il a trouvé **un oubli** (le compteur de
non-lus de `ws-server.mjs`, ligne 4125) que la relecture avait laissé passer.
Un ancien membre aurait continué à voir son compteur monter.

> 🎓 **Leçon.** Quand une règle doit être respectée à 38 endroits, la relire ne
> suffit pas. Il faut une **machine** qui la vérifie à chaque fois.

### Une faille trouvée en passant

La route « supprimer la conversation » laissait **n'importe qui ayant une
ligne** supprimer le groupe **pour tout le monde**. Avec `isMembre`, un ancien
membre aurait gardé ce pouvoir. Corrigé : seul un membre actif agit.

## 3. L'incident de la migration (erreur ET solution)

### Ce que j'ai voulu faire

Vérifier que **toutes** les migrations manuelles se rejouent sans erreur sur
la vraie base, **sans rien changer** : les entourer de `BEGIN … ROLLBACK`.

### Ce qui s'est passé

1. **Dix** fichiers de `prisma/manual/` contiennent **leur propre**
   `BEGIN … COMMIT`. Le premier `COMMIT` rencontré a validé pour de bon : ma
   nouvelle migration a été **appliquée en production**, alors que je voulais
   seulement la tester.
2. Le fichier qui enchaînait les autres était **dans** le dossier qu'il
   parcourait : il s'est inclus lui-même, en boucle, jusqu'à « Too many open
   files ».

### Pourquoi ce n'était pas grave, cette fois

La migration est **additive** (des colonnes avec valeur par défaut, des tables
vides) et elle était prête. Vérifié aussitôt : 387 participants tous membres,
181 conversations en version 0, tables vides, aucun verrou, API en bonne
santé.

### La règle qui en sort

- Un `ROLLBACK` autour d'un fichier qui fait son propre `COMMIT` **ne protège
  rien**.
- On ne teste en `BEGIN … ROLLBACK` qu'un **seul** fichier, après avoir vérifié
  qu'il ne contient pas de `COMMIT`.
- La preuve de structure se fait sur une **base jetable**.
- Un script qui parcourt un dossier ne vit **jamais** dans ce dossier.

## 4. Le périmètre : qui peut chiffrer

### La règle change

Jusqu'ici, seuls les comptes **personnels** (type 0) chiffraient. Décision du
09/10 : les **agents** (2), les **numéros de centre d'appels** (3) et les
**centres vocaux** (4) chiffrent aussi, à deux comme en groupe.

Restent dehors :

- le **9** (administrateur de la plateforme) ;
- tout type **inconnu** — c'est une **liste blanche** : un type nouveau est
  refusé sans que personne ait à y penser.

### Le refus provisoire : les comptes qui envoient par l'API

Les codes OTP sont écrits **par le serveur**, au nom d'un compte développeur.
Le serveur ne peut pas écrire dans une conversation chiffrée. Si on chiffrait
un tête-à-tête avec ce compte, **les codes n'arriveraient plus**.

Donc : un tête-à-tête dont un participant a un compte développeur ne se
chiffre pas (motif `EMETTEUR_API`). À retirer quand le compte système
« Alanya » enverra ces messages.

> 🎓 **Leçon.** Une règle de sécurité qui casse un service essentiel sera
> contournée. Mieux vaut une exception **nommée, datée, avec sa condition de
> fin** qu'un trou silencieux.

## 5. Activer un groupe

- **Seul un administrateur** active.
- La requête dit **quel appareil** va tirer la clé (`appareil`), et cet
  appareil doit avoir publié ses clés : c'est sa signature que les membres
  vérifieront.
- Le drapeau `e2eeActif` et la **version 1** s'écrivent **dans la même
  transaction**.

### Le piège des deux administrateurs

Deux administrateurs appuient au même instant. Sans précaution, le second
butte sur la clé primaire de `e2ee_cle_versions` : **erreur 500** pour une
situation normale.

La parade : la bascule est **conditionnelle** (`e2eeActif = false` dans le
`WHERE`). Un seul la gagne ; l'autre reçoit « déjà activé ». Prouvé par le
banc : deux requêtes simultanées, une seule ligne de version.

## 6. Le message de groupe, côté serveur

```json
{ "chiffre": true, "groupe": { "version": 3, "appareil": 1, "corps": "AQ…" } }
```

| Contrôle | Pourquoi |
|---|---|
| la **forme** (base64, premier octet `0x01`, taille) | ne pas ranger n'importe quoi |
| la **version courante** | après une exclusion, l'ancienne clé est connue de l'exclu |
| l'**appareil** a une identité | sinon personne ne peut vérifier la signature |
| un groupe chiffré **exige** cette charge | une ligne sans corps serait illisible pour toujours |

Le corps est écrit **avec** la ligne du message, en une seule écriture.

### `VERSION_PERIMEE` n'est pas une erreur

C'est le refus qu'un client **à jour** rencontrera : la clé a changé pendant
qu'il chiffrait. La réponse donne la version courante ; le client attend le
trousseau et rechiffre. Aucun message n'est perdu.

### Ce qu'il a fallu fermer ailleurs

Le **WebSocket** accepte un message vide dans un fil chiffré (le texte est
ailleurs, dans les enveloppes). Dans un groupe, il aurait créé une bulle **sans
corps**, illisible à jamais. Il refuse désormais tout envoi dans un groupe
chiffré : le seul chemin est la route REST.

### Modifier, supprimer

- **Modifier** : le nouveau chiffré **remplace** l'ancien, avec la version
  courante.
- **Supprimer pour tous** : le chiffré est **effacé**. Sans cela, un membre qui
  relit l'historique déchiffrerait encore ce que l'auteur a retiré.

## 7. Changer la clé

`POST /conversations/:id/e2ee/versions` avec `{ attendue: n + 1, … }`.

Le numéro **attendu** rend la réservation atomique : deux administrateurs
demandent tous deux la 3, un seul l'obtient, l'autre reçoit `VERSION_CONFLIT`
et sait qu'un trousseau arrive.

### Le risque assumé

Réserver une version puis **ne rien distribuer** (téléphone éteint juste après)
bloque les envois : tout le monde attend une clé que personne n'a. Le remède
est le même bouton : n'importe quel administrateur réserve la suivante et
distribue. Les messages attendent sur les appareils ; aucun n'est perdu.

## 8. Les sonnettes

| Trame | Pour qui | Pour quoi |
|---|---|---|
| `e2ee_arrivee` + `groupe` | tous les membres | un message est lisible |
| `e2ee_cle_version` | tous les membres | une nouvelle clé arrive |
| `e2ee_membre_parti` | le partant | effacer son trousseau |

La trame ne porte **jamais** le chiffré : des identifiants seulement. Prouvé
par le banc.

### L'extraction de l'annonce

La sonnette et la notification existaient déjà, dans la route des enveloppes.
Plutôt que de les **copier** pour le groupe, elles sont sorties dans
`src/lib/e2ee-annonce.ts`. Une copie avait déjà causé une notification **en
double** (commit `445266e`) : on ne recommence pas.

## 9. Un piège de banc : le tuyau abîmé (erreur ET solution)

Le banc des dépôts échouait : « Bob est sonné » ✗.

Ce n'était **pas** mon code : rejoué avec l'ancienne route, même échec. La
cause : j'avais lancé le serveur avec `WS_INTERNAL_SOCKET='\\.\pipe\…'` depuis
**Git Bash**, qui a abîmé les antislashs. L'API parlait à un tuyau qui
n'existait pas, et **en silence** (le pont des personnes ne journalise pas ses
échecs, volontairement).

La solution : ne rien poser. Sous Windows, le code choisit déjà le bon tuyau
par défaut.

> 🎓 **Leçon.** Quand un test échoue, rejoue-le **avec l'ancien code** avant de
> chercher dans le nouveau. Si l'ancien échoue aussi, le problème est dans
> l'environnement.

## 10. Ce qui a été prouvé

| Banc | Contrôles |
|---|---|
| `appartenance-banc.mjs` | 20 ✓ |
| `perimetre-banc.mjs` | 31 ✓ |
| `groupe-chiffre-banc.mjs` (sonnettes comprises) | 54 ✓ (57 depuis le lot 4 ; « 56 » écrit d'abord était faux) |
| `e2ee-depot-banc.mjs`, `e2ee-clair-banc.mjs` (non-régression) | verts |
| `appartenance-garde.mjs` | 234 fichiers, aucun oubli |

Ce qui **n'est pas** prouvé ici : qu'un vrai téléphone et le web s'échangent
un trousseau et lisent un message de groupe. Ce sont les lots 3 à 8.

## 11. À retenir

1. **Un départ se marque, il ne s'efface pas** — et chaque lecture doit alors
   filtrer. Une machine le vérifie.
2. **Un `ROLLBACK` ne protège pas d'un `COMMIT` écrit dans le fichier.**
3. **Liste blanche** pour les types de compte ; **exception nommée et datée**
   pour l'API.
4. **Ce qui peut arriver deux fois en même temps** (activer, changer la clé)
   se règle par une écriture **conditionnelle**, pas par une vérification
   préalable.
5. **La version courante est exigée** à l'écriture : c'est ce qui rend
   l'exclusion réelle.
6. **On n'écrit pas deux fois le même code** de notification.
