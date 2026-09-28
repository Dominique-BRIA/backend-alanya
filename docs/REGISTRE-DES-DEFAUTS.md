# Registre des défauts

> **À quoi sert ce document.** Les chapitres de `docs/cours/` **racontent**. Ce
> registre **liste**. On vient y chercher une ligne, pas une histoire.
>
> Chaque entrée dit quatre choses : ce qu'on voyait, ce que c'était vraiment,
> **pourquoi rien ne l'a vu**, et ce qui l'empêche de revenir.
>
> La troisième colonne est la plus utile. Un défaut corrigé revient ; un trou de
> détection laisse passer tous ses successeurs.
>
> Période couverte : 26–27/09/2026. Dépôts `backend-alanya`, `STAGE-WEB`,
> `alanya`.

---

## Sommaire

- [A. Les pannes muettes](#a-les-pannes-muettes)
- [B. Les diagnostics qui mentent](#b-les-diagnostics-qui-mentent)
- [C. Le coffre sécurisé Android](#c-le-coffre-sécurisé-android)
- [D. Le contrat client/serveur](#d-le-contrat-clientserveur)
- [E. Les défenses qui ne défendaient rien](#e-les-défenses-qui-ne-défendaient-rien)
- [F. Les bancs eux-mêmes](#f-les-bancs-eux-mêmes)
- [G. La relève](#g-la-relève-28092026)
- [H. Les portes latérales du clair](#h-les-portes-latérales-du-clair-28092026)
- [I. Lots 3 à 6](#i-lots-3-à-6-28092026)
- [Les six motifs qui reviennent](#les-six-motifs-qui-reviennent)
- [Les garde-fous en place](#les-garde-fous-en-place)

---

## A. Les pannes muettes

### A-1 · Chargement infini à l'ouverture d'une conversation

| | |
|---|---|
| **Symptôme** | Le rond tourne sans fin. Les messages existent, le web les voit. |
| **Cause réelle** | `package:http` **n'a aucun délai par défaut**. Une requête sans réponse attend indéfiniment : son `Future` ne se termine ni en succès ni en erreur. |
| **Pourquoi rien ne l'a vu** | Le code avait un `try/catch` qui éteignait l'indicateur dans les deux branches. **Aucune des deux ne s'exécute si l'attente ne revient pas.** |
| **Correctif** | 30 s sur les appels JSON d'`ApiClient` (hors multipart), 5 s sur le coffre, 3 s sur le cache `sqflite`, et l'extinction dans un `finally`. |
| **Garde-fou** | Le `finally` : même une cause inconnue ne peut plus figer l'écran. |
| **Commit** | `33ff93a`, précédé de `a4daaf2` |

> 🔴 **Un `try/catch` ne protège pas d'une attente sans fin.** Il n'attrape que
> ce qui est **levé**. Ce qui ne revient pas ne lève rien.

### A-2 · Cinquante écritures sur le canal de plateforme au démarrage

| | |
|---|---|
| **Symptôme** | Même chargement infini, avant A-1. |
| **Cause réelle** | Les 50 pré-clés s'écrivaient **une par une** dans le coffre sécurisé. La lecture du jeton passait derrière. |
| **Pourquoi rien ne l'a vu** | Rien ne mesure le canal de plateforme. Il se comporte comme une file d'attente partagée, jamais comme une base. |
| **Correctif** | Les pré-clés tiennent dans une seule entrée ; le cache s'affiche **avant** toute lecture de coffre. |
| **Commit** | `a4daaf2` |

### A-3 · Le démarrage du chiffrement échouait sans laisser de trace

| | |
|---|---|
| **Symptôme** | « Le chiffrement n'a pas pu être activé », sans plus. |
| **Cause réelle** | `demarrer()` rattrapait toute exception — ce qui est juste — **mais n'en gardait rien**. |
| **Pourquoi rien ne l'a vu** | C'est le trou lui-même : le `catch` effaçait la seule trace. Deux jours perdus. |
| **Correctif** | `echecDemarrage` retient la cause ; l'écran d'activation la montre **avant** le message du serveur. |
| **Commit** | `e8d7210` |

> 🔴 **Rattraper sans garder, c'est effacer la seule trace.** Un `catch` qui ne
> retient pas ce qu'il attrape ne rend pas l'application robuste : il la rend
> muette.

---

## B. Les diagnostics qui mentent

### B-1 · « Impossible de contacter le serveur » pour toute panne

| | |
|---|---|
| **Symptôme** | Message affiché à la connexion, alors que le serveur répondait. |
| **Cause réelle** | `catch (_)` attrapait **tout** ce qui n'est pas une `ApiException` — coffre illisible, conversion ratée, préférence qui lève — et rangeait chaque cas sous la même étiquette. |
| **Pourquoi rien ne l'a vu** | Le message existait, était traduit dans 9 langues, et paraissait soigné. **Sonde de production : 401 en 1,45 s / 0,65 s / 1,07 s.** Le serveur allait très bien. |
| **Correctif** | `lib/core/erreur_lisible.dart` classe en trois : réponse du serveur / panne réseau avérée / type + texte de l'erreur. |
| **Commit** | `b367475` |

> ⚠️ **Un message d'erreur est un outil de diagnostic avant d'être une
> politesse.** Celui qui range toutes les pannes sous une seule étiquette coûte
> plus cher que pas de message : il donne une piste, et elle est fausse.

### B-2 · Le message accusait le correspondant

| | |
|---|---|
| **Symptôme** | « Vérifiez que votre correspondant a ouvert l'application récemment. » |
| **Cause réelle** | Le serveur distingue **trois** refus (`CLES_MANQUANTES`, `HORS_PERIMETRE`, `GROUPE_NON_SUPPORTE`). Tous étaient aplatis en une phrase qui désignait l'autre. |
| **Pourquoi rien ne l'a vu** | Le participant sans clés, c'était **ce téléphone**. Le serveur ne peut pas le dire : il ne voit qu'une identité absente, pas la raison de son absence. |
| **Correctif** | On répète le message du serveur, et notre propre échec passe devant quand il existe. |
| **Commit** | `1cb4b3d`, `e8d7210` |

### B-3 · Un commentaire décrivait une intention comme un fait

| | |
|---|---|
| **Symptôme** | Aucun. C'est tout le problème. |
| **Cause réelle** | « Le stock se réapprovisionnera quand il baissera. » **Rien ne l'implémentait.** |
| **Pourquoi rien ne l'a vu** | Le commentaire a fait passer plusieurs relectures à côté — dont les miennes. |
| **Correctif** | `reapprovisionnerSiNecessaire()`, et le commentaire dit ce que le code fait. |
| **Commit** | `d79c2ab` |

> 🔴 **Un commentaire qui décrit une intention comme un fait est pire que pas de
> commentaire.**

---

## C. Le coffre sécurisé Android

### C-1 · Reconnexion impossible après déconnexion

| | |
|---|---|
| **Symptôme** | `PlatformException(Migration failed after algorithm change (Invalid key…))` |
| **Cause réelle** | Trois décisions raisonnables **prises ensemble** : `encryptedSharedPreferences: true` (déprécié et ignoré en v10, mais il **déclenche la migration** des données héritées), `resetOnError: false`, et un espace de nom partagé. |
| **Pourquoi rien ne l'a vu** | La prudence « ne jamais effacer silencieusement » est bonne **pour une clé**. Ce coffre ne contenait que des jetons — du jetable. Refuser de l'effacer coûtait l'accès au compte, sans porte de sortie. |
| **Correctif** | Paramètre déprécié retiré ; `resetOnError: true` ; `storageNamespace: 'alanya_session'`. |
| **Commit** | `145f0af` |

> 🔴 **On ne protège de l'effacement que ce qu'on ne peut pas refabriquer.** Un
> jeton se refabrique en tapant son mot de passe.

### C-2 · Les clés Signal restées dans l'espace empoisonné

| | |
|---|---|
| **Symptôme** | Connexion réparée, mais aucune clé publiée. |
| **Cause réelle** | J'avais déplacé les **jetons** dans un espace propre et laissé le **coffre E2EE** dans l'espace par défaut — celui qui porte les données héritées dont la migration échoue. Avec `resetOnError: false`, chaque lecture levait. |
| **Pourquoi rien ne l'a vu** | A-3 : `demarrer()` rattrapait sans rien garder. |
| **Correctif** | `storageNamespace: 'alanya_e2ee'`. |
| **Commit** | `e8d7210` |

> ⚠️ **Les deux réglages se tiennent** : refuser l'effacement n'est tenable que
> dans un espace dont on maîtrise le contenu. Les mélanger revenait à laisser
> les jetons décider du sort des clés Signal.

### C-3 · Le coffre E2EE aurait détruit l'identité en silence

| | |
|---|---|
| **Symptôme** | Aucun — défaut latent, trouvé en relecture. |
| **Cause réelle** | Le coffre E2EE utilisait la valeur par défaut `resetOnError: true`. Une erreur de déchiffrement aurait **effacé l'identité Signal sans rien dire**. |
| **Pourquoi rien ne l'a vu** | Le cas ne s'était pas encore produit. Et il n'aurait produit aucune erreur. |
| **Correctif** | `resetOnError: false` sur ce coffre — l'inverse de C-1, pour la raison inverse. |
| **Commit** | `145f0af` |

---

## D. Le contrat client/serveur

### D-1 · Le mobile n'avait jamais publié une seule clé

| | |
|---|---|
| **Symptôme** | « Il n'y a pas les clés » quand le correspondant est hors ligne — signalé des semaines plus tôt, et mal attribué à la présence. |
| **Cause réelle** | `POST /api/e2ee/cles` sur une route qui n'exporte que `GET`, `PUT`, `DELETE` → **405**. Et les noms de champs divergeaient : `prekeysUniques`/`prekeyId` au lieu de `prekeys`/`id`. |
| **Pourquoi rien ne l'a vu** | Trois filets, et le défaut passe entre les trois : `dart analyze` ne connaît pas les routes ; le banc d'interopérabilité **branche une fausse fonction réseau** (il éprouve le protocole, jamais le contrat HTTP) ; `demarrer()` rattrape tout. |
| **Correctif** | `PUT`, et les noms du serveur. |
| **Garde-fou** | `outils/contrat_routes.py` |
| **Commit** | `d79c2ab` |

### D-2 · Le `default` de l'adaptateur devinait — et se trompait

| | |
|---|---|
| **Symptôme** | « Erreur 405 », **après** D-1 corrigé. |
| **Cause réelle** | `PileE2ee.pour` traduit le verbe en méthode du client. Pas de cas `PUT` → `default:` → **`PATCH`**. Le verbe écrit et le verbe émis n'étaient pas le même. |
| **Pourquoi rien ne l'a vu** | Le garde-fou de D-1 comparait le verbe **écrit** à celui qu'expose la route. `PUT` contre `PUT` : vert. |
| **Correctif** | Cas `PUT` et `PATCH` explicites ; le `default` **lève**. |
| **Garde-fou** | `contrat_routes.py` lit désormais les `case` de l'adaptateur — pas son `default`, qui n'est pas une prise en charge. |
| **Commit** | `994cd4f` |

> 🔴 **Le défaut n'était pas l'oubli, c'était le `default`.** Un oubli se voit :
> le code ne compile pas, ou il lève. Ici, l'oubli avait une porte de sortie qui
> prenait silencieusement une autre décision.

### D-3 · Les serrures de l'archive partaient aussi en PATCH

| | |
|---|---|
| **Symptôme** | Aucun isolé — masqué par D-1 et D-2. |
| **Cause réelle** | Même cause que D-2 : `PUT /api/e2ee/coffre` traduit en `PATCH`. |
| **Pourquoi rien ne l'a vu** | **C'est l'épreuve du garde-fou qui l'a trouvé**, pas moi : en remettant l'état fautif pour vérifier qu'il mordait, il a signalé deux appels au lieu d'un. |
| **Commit** | `994cd4f` |

### D-4 · Clés de traduction en double — build cassé, invisible à l'analyseur

| | |
|---|---|
| **Symptôme** | La construction CI échoue. **Les correctifs poussés n'arrivaient donc jamais sur l'appareil.** |
| **Cause réelle** | Deux branches ajoutent le même bloc de traductions à des endroits différents. **Git ne voit aucun conflit.** |
| **Pourquoi rien ne l'a vu** | Une clé répétée dans une `const Map` n'échoue qu'à l'**évaluation des constantes**, donc à la compilation. `flutter analyze` ne fait que lire le code. |
| **Garde-fou** | `outils/doublons_traductions.py`, en CI **avant** Gradle. |
| **Commit** | `33ff93a` |

### D-5 · Deux constructions CI pour un seul commit

| | |
|---|---|
| **Cause réelle** | `push` **et** `pull_request` couvraient la même branche, avec une PR ouverte depuis elle. |
| **Correctif** | `push` seul, plus un groupe de concurrence par branche. |
| **Commit** | `994cd4f` (déclencheurs), `145f0af` |

---

## E. Les défenses qui ne défendaient rien

### E-1 · L'alerte de changement de clé s'évaporait

| | |
|---|---|
| **Symptôme** | Aucun — et c'est ce qui le rend grave. |
| **Cause réelle** | L'alerte vivait dans un `Set` **en mémoire**, des deux côtés. Or `isTrustedIdentity` rend toujours `true` : quand on détecte le changement, **la nouvelle clé est déjà écrite**. Rien ne peut le redétecter. |
| **Pourquoi rien ne l'a vu** | Le commentaire justifiait le choix par un argument juste — « une alerte qui se répète cesse d'être lue » — qui masquait le reste. |
| **Conséquence** | **Une substitution de clé réussie pouvait passer inaperçue.** Il suffisait d'un rechargement de page, ou d'une fermeture de l'application. |
| **Correctif** | L'alerte vit dans le coffre et ne s'éteint que sur un **accusé de lecture**. Elle ne se répète jamais, et ne se perd jamais. |
| **Garde-fou** | `scripts/e2ee-cle-changee.mjs` |
| **Commit** | `b300572` (web), `d79c2ab` (mobile) |

### E-2 · Les pré-clés ne se réapprovisionnaient jamais (mobile)

| | |
|---|---|
| **Cause réelle** | Le serveur réclame par `reapproNecessaire` depuis le premier jour. Le web écoute, le mobile non. |
| **Conséquence** | Au 51ᵉ correspondant, **plus personne ne peut ouvrir de conversation avec ce téléphone**. Panne muette : ce sont les *autres* qui n'y arrivent plus. |
| **Piège dans le piège** | Les identifiants partaient de `0`. Republier aurait rendu les **mêmes numéros**, que le serveur écarte (`skipDuplicates`) — le correctif « évident » n'aurait rien réapprovisionné. |
| **Commit** | `d79c2ab` |

### E-3 · Le serveur choisissait la fonction de dérivation

| | |
|---|---|
| **Cause réelle** | `algo` et `parametres` sont écrits par nous à la pose, mais étaient **relus tels quels** à l'ouverture. |
| **Portée exacte** | **Pas une divulgation de clé** — le paquet reste chiffré sous la vraie KEK. Ce qu'on évite : le déni de service (`memoireKio: 4000000` réclame 4 Go à Argon2id) et le déclassement à venir. |
| **Correctif** | Liste blanche sur les deux clients ; un type de serrure inconnu est refusé, pas deviné. |
| **Commit** | `b300572`, `d79c2ab` |

### E-4 · Le chiffrement invisible après connexion

| | |
|---|---|
| **Symptôme** | « Vérifier le code de sécurité » n'apparaît qu'après un redémarrage. |
| **Cause réelle** | `PileE2ee` était construit **une fois, avant `runApp`**, depuis le profil déjà rangé. Application ouverte déconnectée → fournisseur **non enregistré**, donc impossible à faire apparaître ensuite. |
| **Pourquoi rien ne l'a vu** | Les écrans testent `context.e2ee != null` pour ne pas planter avant la connexion. L'absence ressemblait à une fonctionnalité désactivée. |
| **Correctif** | `ProxyProvider<AuthController, PileE2ee?>`, qui suit le compte et **garde** la pile tant qu'il ne change pas. |
| **Commit** | `1cb4b3d` |

### E-5 · Les pièces jointes non chiffrées, tues sur mobile

| | |
|---|---|
| **Cause réelle** | Le web affichait « les fichiers joints ne sont pas encore chiffrés ». Le mobile n'avait **même pas la clé de traduction**. |
| **Pourquoi c'est grave** | Ce n'est pas un manque, c'est une **promesse fausse**. Reporter une fonctionnalité se décide ; le silence ne se décide pas — il trompe. |
| **Commit** | `d79c2ab` |

---

## F. Les bancs eux-mêmes

### F-1 · Trois vérifications vertes, pour la mauvaise raison

| | |
|---|---|
| **Cause réelle** | `ouvrirArchive` prend **une** serrure ; je lui passais un **tableau**. `serrure.sel` valait `undefined`, `atob(undefined)` levait — et `leve()` était content. |
| **Conséquence** | Les trois contrôles de la liste blanche ne prouvaient **rien**. |
| **Correctif** | Un témoin avant toute série de refus : « la serrure s'ouvre **avant** qu'on y touche ». |
| **Commit** | `b300572` |

> 🔴 **Un banc qui passe pour la mauvaise raison est pire qu'un banc qui
> échoue** : il distribue de la confiance sans rien prouver.

### F-2 · Un banc de persistance qui ne teste pas la persistance

| | |
|---|---|
| **Cause réelle** | `ouvrirCoffre()` met son ouverture **en cache**. Relire dans le même module ne relit rien — **l'ancien `Set` en mémoire aurait passé.** |
| **Correctif** | Le lanceur charge le module **trois fois** (`?v=1`, `?v=2`, `?v=3`) sur la même base IndexedDB. |
| **Commit** | `b300572` |

### F-3 · Un banc qui passe sur un fichier vide

| | |
|---|---|
| **Règle appliquée** | `doublons_traductions.py` et `contrat_routes.py` **échouent** si aucune table de langue, aucun appel, ou aucun `switch` n'est reconnu. |
| **Pourquoi** | Si le format change et que le script ne reconnaît plus rien, il doit le dire — pas annoncer « aucun problème ». |

---

## G. La relève (28/09/2026)

> Récit complet : [chapitre 11](cours/11-la-releve-qui-jetait-le-courrier.md).

### G-1 · Le texte des autres fils, acquitté puis jeté

| | |
|---|---|
| **Symptôme** | « Message chiffré — indisponible sur cet appareil », sur des messages reçus. |
| **Cause réelle** | La relève rend les enveloppes de TOUS les fils et les acquitte toutes ; l'écran ne rangeait que le fil ouvert. |
| **Pourquoi rien ne l'a vu** | Tous les bancs n'avaient qu'UN fil chiffré. Et le libellé, juste pour un autre cas, présentait celui-ci comme normal. |
| **Correctif** | Rangement dans la relève, fil par fil, AVANT l'acquittement (`e2ee-releve.ts`, `PileE2ee.releverEtRanger`). |
| **Garde-fou** | `STAGE-WEB/scripts/e2ee-releve-multifil.mjs` (Chrome, 3 comptes) ; `alanya/test/e2ee_releve_test.dart` groupe ③ |
| **Commit** | `d8a7eb8` (web), `3e4ffbb` (mobile) |

### G-2 · Deux relèves simultanées effaçaient la session (mobile)

| | |
|---|---|
| **Symptôme** | « 1 message illisible — session réinitialisée » sans raison, puis le message suivant perdu. |
| **Cause réelle** | Trois relèves lancées sans attente, dont deux pour le même message ; la seconde échoue sur un message déjà ouvert et efface la session. Le coffre, sans verrou, réécrit des tables entières. |
| **Pourquoi rien ne l'a vu** | Le web est protégé par sa bibliothèque (`SessionLock`), le mobile non. Et un test sans vrai tour de boucle ne fait jamais s'entrelacer deux appels. |
| **Correctif** | File des relèves dans `E2eeFil` ; accès au coffre sérialisé dans `E2eeService`. |
| **Garde-fou** | `alanya/test/e2ee_releve_test.dart` groupe ① |
| **Commit** | `3e4ffbb` |

### G-3 · L'illisible jamais acquittée

| | |
|---|---|
| **Symptôme** | Mobile : conversation cassée pour de bon après une seule illisible. Web : plus rien n'arrive après 200 illisibles. |
| **Cause réelle** | Gardée « pour ne pas la perdre », relue à chaque relève — et, sur mobile, chaque échec effaçait la session rétablie entre-temps. |
| **Pourquoi rien ne l'a vu** | La règle « ne pas perdre » était juste pour une panne passagère ; personne n'avait distingué passager et définitif. |
| **Correctif** | Échecs classés : déjà lu / passager (gardé) / définitif (acquitté, session effacée une fois). |
| **Garde-fou** | Banc web, étape ⑥ ; test mobile, groupe ② |
| **Commit** | `fa8c882` (web), `3e4ffbb` (mobile) |

---

## H. Les portes latérales du clair (28/09/2026)

> Récit complet : [chapitre 12](cours/12-les-portes-laterales.md).

### H-1 · Modifier un message chiffré l'écrivait en clair

| | |
|---|---|
| **Symptôme** | Aucun à l'écran. Le texte modifié était lisible en base, dans l'aperçu et chez les participants. |
| **Cause réelle** | `edit_message` et `PATCH` n'avaient aucune garde E2EE ; le mobile proposait « Modifier » sur une bulle chiffrée. |
| **Pourquoi rien ne l'a vu** | La garde du clair était posée sur l'ENVOI, pas sur la colonne `message.content`. |
| **Correctif** | Refus serveur `CONVERSATION_CHIFFREE` + menu masqué sur mobile. |
| **Garde-fou** | `scripts/e2ee-clair-banc.mjs` ① |
| **Commit** | `609cdda` (backend), `3430bd4` (mobile) |

### H-2 · Transférer : bulle vide depuis un fil chiffré, clair vers un fil chiffré

| | |
|---|---|
| **Cause réelle** | Le transfert recopie `content`, vide pour un chiffré et en clair pour les autres. |
| **Pourquoi rien ne l'a vu** | Même trou que H-1. |
| **Correctif** | `refusTransfert` dans `src/lib/e2ee-clair.mjs`, partagé REST/WebSocket ; menus masqués (web, mobile) ; sélecteur mobile sans fils chiffrés pour un texte. |
| **Garde-fou** | `scripts/e2ee-clair-banc.mjs` ② |
| **Commit** | `609cdda`, `c71e286` (web), `3430bd4` |

### H-3 · 🔴 Recopier le message d'une conversation dont on n'est pas membre

| | |
|---|---|
| **Symptôme** | Aucun. Bob pouvait copier chez lui un message Alice–Carole et le lire. |
| **Cause réelle** | La route REST de transfert vérifiait l'appartenance au fil de l'ADRESSE, puis cherchait le message par son seul identifiant. |
| **Pourquoi rien ne l'a vu** | Le WebSocket faisait le contrôle ; le « repli » REST était relu comme une copie. |
| **Correctif** | Le message doit appartenir au fil de l'adresse, sinon 404. |
| **Garde-fou** | `scripts/e2ee-clair-banc.mjs` ③ |
| **Commit** | `609cdda` |

---

## I. Lots 3 à 6 (28/09/2026)

> Une ligne par défaut ; le récit est dans les chapitres 13 à 16.

| Défaut | Pourquoi rien ne l'a vu | Garde-fou | Commits |
|---|---|---|---|
| Le web refaisait un X3DH à chaque envoi | Un commentaire affirmait que la bibliothèque ne le faisait pas ; les messages arrivaient quand même (40 sessions gardées) | multifil ⑧ | `6de8890` |
| Chaque envoi consommait une pré-clé du correspondant (web + mobile) | « Demander le paquet » ressemblait à une lecture | multifil ⑧, test mobile ④ | `dbd5e4f`, `a435380` |
| Appareil réinstallé : on chiffrait sur la session de l'ancienne identité | On testait « session existe », pas « même clé » | test mobile ④ | `a435380` |
| Numéros de pré-clés tirés au sort, collisions possibles | Trop rare pour se voir ; `skipDuplicates` muet | multifil ⑨, test mobile ⑤ | `6de8890`, `a435380` |
| Clé de récupération à 60 bits, non étirée | Un compromis argumenté sur le mauvais levier ; un commentaire disait « 256 bits » | e2ee-serrures, test mobile | `cad9287`, `f863107` |
| Pas de moyen de remplacer une clé faible | L'écran ne proposait la clé que si absente | e2ee-ecran ④ | `95e43dd`, `e33fe67` |
| Deux notifications par message chiffré | Deux blocs, deux commentaires convaincants | **aucun** (push inerte en local) — preuve par lecture | `4a981ae` |
| Aucun envoi vers ses propres autres appareils | Le serveur l'avait prévu, aucun client ne s'en servait | multifil ⑩, test mobile ⑥ | `1cd4e6f`, `63e8d74` |
| Archive tronquée à 2 000 blocs (les plus récents perdus) | `total` valait le nombre rendu | archive-banc ⑧, serrures ⑩, test mobile | `14d9cf7`, `5d3a86b`, `77db0f4` |
| Un appareil ajouté chez un correspondant n'alertait pas | Seul le changement de clé d'un appareil connu était pensé | cle-changee ⑤, test mobile ⑦ | `65a4024`, `322f640` |
| N'importe qui pouvait vider le stock de pré-clés d'un autre | La route n'avait qu'`withAuth` | e2ee-banc ⑬ | `64af118` |
| Identité jamais relevée servie pour toujours | `null` passait le filtre des 30 jours | e2ee-banc ⑭ | `64af118` |
| 🔴 Regex `r's+'` au lieu de `r'\s+'` (écrite pendant le lot 4) | `analyze` ne voit pas une regex fausse mais valide | test mobile (clés tirées → normalisées intactes) | attrapé avant commit |

---

## Les six motifs qui reviennent

Si vous ne retenez que cette section, retenez celle-ci.

### ① Le `catch` qui n'attrape pas ce qu'on croit

Un `try/catch` n'attrape que ce qui est **levé**. Une attente sans fin ne lève
rien ; un `Future` qui ne revient pas n'exécute aucune des deux branches.
→ **A-1**

### ② Le `catch` qui attrape et jette

Rattraper sans garder rend l'application muette, pas robuste. Si vous rattrapez
pour ne pas bloquer, **retenez la cause quelque part**.
→ **A-3, C-2**

### ③ Le chemin par défaut qui décide à votre place

`default:`, valeur par défaut d'une option, repli « au plus proche ». Un oubli
se voit ; un oubli avec porte de sortie prend silencieusement une autre
décision, parfois pendant des semaines.
→ **D-2, C-3**

### ④ Le double de test qui remplace précisément ce qu'on veut éprouver

Le banc d'interopérabilité branche une fausse fonction réseau : il prouve le
protocole, pas le contrat HTTP. Le garde-fou de D-1 lisait le verbe écrit, pas
le verbe émis. **Un contrôle qui s'arrête avant la traduction ne contrôle que
l'intention.**
→ **D-1, D-2, F-2**

### ⑤ Le texte qui affirme plus que le code

Commentaires et messages d'erreur vieillissent sans que rien ne les contredise.
Un commentaire faux fait passer les relectures suivantes à côté ; un message
d'erreur faux envoie chercher au mauvais endroit.
→ **B-1, B-2, B-3, E-5**

### ⑥ La prudence appliquée au mauvais objet

« Ne jamais effacer » est juste pour une clé, ruineux pour un jeton. « Ne pas
répéter l'alerte » est juste, mais pas au prix de la perdre. **La bonne question
n'est pas « est-ce prudent ? » mais « prudent envers quoi ? »**
→ **C-1, C-3, E-1**

---

## Les garde-fous en place

| Outil | Ce qu'il attrape | Où |
|---|---|---|
| `outils/doublons_traductions.py` | Clés de traduction répétées — invisibles à `flutter analyze` | `alanya`, **en CI avant Gradle** |
| `outils/contrat_routes.py` | Verbe/chemin inconnus de la route, **et** verbe non traduit par l'adaptateur | `alanya`, manuel |
| `scripts/e2ee-cle-changee.mjs` | L'alerte d'interposition qui se perd, ou qui se répète | `STAGE-WEB` |
| `scripts/e2ee-serrures.mjs` §⑨ | Paramètres de dérivation dictés par le serveur | `STAGE-WEB` |
| `lib/core/erreur_lisible.dart` | Toute panne rangée sous « serveur injoignable » | `alanya` |
| `flutter test` (189 tests, dont `e2ee_releve_test.dart`) | **Ne tourne pas en CI** — voir ci-dessous | `alanya` |

### Ce qui manque encore

- **La CI mobile ne lance ni `flutter test` ni `flutter analyze`.** 185 tests
  passent et n'ont jamais rien protégé.
- **`contrat_routes.py` ne vérifie pas les noms de champs du corps** — c'était
  la deuxième erreur de D-1.
- **Le backend n'a aucune CI ni aucun test**, sur 133 routes et 92 tables.

---

## Comment ajouter une entrée

Quatre lignes suffisent, et la troisième est obligatoire :

```
| **Symptôme**            | ce qu'on voyait                    |
| **Cause réelle**        | ce que c'était                     |
| **Pourquoi rien ne l'a vu** | ← celle-ci                     |
| **Garde-fou**           | ou « aucun », et c'est une dette   |
```

> Si vous ne savez pas remplir la troisième ligne, le défaut n'est pas encore
> compris — seulement corrigé.
