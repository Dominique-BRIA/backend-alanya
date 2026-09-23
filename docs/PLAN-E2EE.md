# Plan d'implémentation — Chiffrement de bout en bout

> **Établi le 23/09/2026**, après audit du code existant.
>
> Ce plan ne liste pas ce qu'on imagine : chaque point du **lot 0** a été
> vérifié dans le code. Les références de fichiers sont exactes.

---

## 1. Où nous en sommes

### Livré et éprouvé

| | |
|---|---|
| X3DH + Double Ratchet, client web | ✅ |
| Périmètre : personnel ↔ personnel uniquement (liste blanche) | ✅ |
| Bannière « à partir d'ici, chiffré » | ✅ |
| Avertissement de changement de clé | ✅ |
| Refus du clair — chemin REST **et** chemin WebSocket | ✅ |
| Remise instantanée (la sonnette) | ✅ |
| Identités mortes : balayage 30 j + retrait à la déconnexion | ✅ |
| Cache qui ne perd plus le texte déchiffré | ✅ |
| Coffre local chiffré, clé non extractible | ✅ |

**Bancs** : `e2ee-banc.mjs` (backend), `e2ee-web.mjs` (modules navigateur),
`e2ee-coffre.mjs`, `e2ee-cache.mjs`. Tous verts.

### Ce qui reste — vue d'ensemble

```
  LOT 0  Fuites et manques          🔴 BLOQUANT avant toute mise en production
  LOT 1  Codes de sécurité          ├─ prérequis du lot 3
  LOT 2  Rétention serveur          └─ indépendant
  LOT 3  Archive chiffrée              (historique sur un nouvel appareil)
  LOT 4  Client mobile
  LOT 5  Dette de fond
```

---

## 2. Ce que l'audit a trouvé

Quatre défauts réels, tous invisibles à l'écran.

### 🟠 E-01 — Un moteur de traduction EN LIGNE, s'il est choisi, exfiltre le clair

> ⚠️ **Ce point a été corrigé le 23/09/2026, après lecture du client.** Je
> l'avais d'abord écrit en rouge, sur la seule lecture du relais serveur.
> C'était faux, et c'est exactement la faute contre laquelle le chapitre 3
> met en garde : n'avoir pas regardé **tous** les chemins.

**Ce qui est déjà juste** — `src/services/traduction-service.ts` :

- le moteur du **navigateur est le défaut** ;
- et il n'y a **aucun repli silencieux** vers le relais :

> *« Pas de repli sur le relais : l'utilisateur a choisi que rien ne sorte de
> son appareil, un échec local ne vaut pas autorisation de sortir. »*

**Ce qui reste à faire, et c'est petit** : le relais est toujours
*sélectionnable* dans les Réglages, et **rien ne relie ce réglage à l'état
chiffré d'une conversation**. Un utilisateur qui a choisi Azure fuite — pas
par défaut, mais par réglage.

### 🔴 E-02 — Aucune notification pour un message chiffré

`pushNewMessage` n'est appelé que depuis `ws-server.mjs`. Les messages chiffrés
partent en REST, qui ne notifie personne — et c'est **documenté comme voulu**
dans `creerMessage`.

Conséquence : application fermée, **rien n'arrive**. Jamais.

### 🟠 E-03 — L'aperçu de conversation reste vide

`apercuMessage(type, content)` avec un `content` vide rend `null`. Dans la liste
des conversations, un fil chiffré n'affiche donc **rien** — ni texte, ni
indication.

### 🟠 E-04 — Les médias passent en clair, en silence

Le chiffrement des médias est remis (décision du 21/09). Aujourd'hui ils
traversent le chemin ordinaire **sans que rien ne le dise**. Un fil marqué
« chiffré » transporte des pièces jointes qui ne le sont pas.

### 🟠 E-05 — Les pré-clés ne se réapprovisionnent jamais

`preparerCetAppareil()` rend `prekeysRestantes`, et **personne ne s'en sert**
(vérifié : seul l'écran de test l'affiche). Les 50 pré-clés à usage unique
s'épuisent, et plus aucun nouveau correspondant ne peut ouvrir de session dans
de bonnes conditions.

Bombe à retardement : invisible jusqu'au jour où ça casse.

### 🟠 E-06 — Les pré-clés signées s'accumulent

Toujours dans `preparerCetAppareil()` : la pré-clé signée est régénérée **à
chaque appel**, donc à chaque connexion, et l'ancienne n'est jamais retirée du
coffre. Le coffre étant désormais chargé en mémoire au démarrage, la fuite se
paie deux fois.

---

## 3. LOT 0 — Fuites et manques

> 🔴 **Rien ne part en production avant ce lot.** Les trois premiers points
> font qu'aujourd'hui, le mot « chiffré » affiché à l'écran n'est pas tenu.

| # | ticket | où |
|---|---|---|
| **0.1** | **Dans un fil chiffré, forcer le moteur sur l'appareil** — quel que soit le réglage de l'utilisateur. Le défaut est déjà bon ; c'est le réglage qui n'est relié à rien. | `traduction-service.ts` |
| **0.2** | **Le serveur refuse aussi**, en garde de fond : `/api/translate` rejette un texte venant d'une conversation chiffrée. Une garde côté client seul se contourne. ⚠️ Suppose que le client dise de quelle conversation il parle — à concevoir sans transformer le relais en oracle. | `translate/route.ts` |
| **0.3** | **Notification pour les messages chiffrés.** Le push part du **dépôt des enveloppes** — même endroit que la sonnette, et pour la même raison. Le contenu de la notification est générique : « Nouveau message », jamais un aperçu. | `e2ee/enveloppes/route.ts` |
| **0.4** | **Aperçu de conversation** : poser un libellé neutre (« Message chiffré ») côté serveur, ou laisser le client l'afficher à partir de `e2ee_actif`. Décision à prendre : le serveur ne doit pas mentir sur ce qu'il sait. | backend + web |
| **0.5** | **Dire que les médias ne sont pas chiffrés.** Mention explicite au moment de joindre un fichier dans un fil chiffré. | web |
| **0.6** | **Réapprovisionner les pré-clés** sous un seuil (ex. < 10 sur 50). Déclenché à la connexion et après chaque session ouverte. | web |
| **0.7** | **Rotation propre de la pré-clé signée** : une seule vivante, les anciennes retirées après une fenêtre de grâce (les messages en vol s'y réfèrent encore). | web |

**Banc à écrire** : un fil chiffré ne doit laisser passer **aucun** texte vers
`/api/translate`, ni vers le push. C'est un banc de **non-fuite**, et il doit
échouer si on retire la garde.

---

## 4. LOT 1 — Les codes de sécurité

> **Sans eux, l'avertissement « la clé a changé » est inutilisable** : il dit à
> l'utilisateur qu'il se passe peut-être quelque chose de grave, sans lui donner
> le moyen de trancher.
>
> Et il va devenir **fréquent** dès le lot 3 : chaque changement de téléphone en
> produit un.

**Bonne nouvelle** : `FingerprintGenerator` est fourni par la bibliothèque —
`createFor(idLocal, cleLocale, idDistant, cleDistante)`. On n'implémente pas la
cryptographie, seulement l'écran.

| # | ticket |
|---|---|
| **1.1** | Calculer l'empreinte des deux identités. ⚠️ Les identifiants doivent être **stables et identiques des deux côtés**, sinon les deux personnes voient des codes différents et concluent à une attaque. |
| **1.2** | Écran de comparaison : 60 chiffres en 12 groupes de 5, plus un QR code. Lisible au téléphone, à voix haute. |
| **1.3** | Marquer un correspondant comme **vérifié**, et le montrer dans le fil. |
| **1.4** | ✅ **DÉCIDÉ (user, 23/09) : le modèle WhatsApp.** On avertit, on ne bloque **jamais** — vérifié ou non. La vérification achète de la **visibilité**, pas un panneau stop. ⚠️ Conséquence à assumer : un correspondant vérifié dont la clé change peut recevoir un message avant que l'utilisateur n'ait réagi. C'est le choix de la messagerie la plus utilisée au monde, et il se défend : bloquer produit surtout des gens bloqués. ⚠️ Corollaire : l'avertissement doit être **actif par défaut** sur un contact vérifié — chez WhatsApp il est désactivé, ce qui vide la fonctionnalité de son sens. |
| **1.5** | Relier l'avertissement existant à cet écran : l'alerte doit **mener** à la comparaison, pas seulement informer. |

---

## 5. LOT 2 — Rétention serveur

> Indépendant du reste. Peut se faire en parallèle.

| # | ticket |
|---|---|
| **2.1** | **Purger les enveloppes remises** au-delà de N jours. Elles sont **définitivement indéchiffrables** — le ratchet a avancé. On conserve des octets que personne ne lira jamais. Ordre de grandeur : ~450 octets par message, doublé par appareil supplémentaire. |
| **2.2** | ⚠️ Fixer N avec soin : un second appareil doit avoir le temps de relever. 30 jours, aligné sur le balayage des identités mortes. |
| **2.3** | `corps` en `bytea` au lieu de base64 en colonne texte — 25 % d'économie, aucun changement de protocole. |
| **2.4** | Suppression de compte : retirer identités, pré-clés et enveloppes. À vérifier, pas encore audité. |

---

## 6. LOT 3 — L'archive chiffrée

> **L'historique sur un nouvel appareil.** Voir la discussion des 22–23/09 :
> on sauvegarde **les messages**, pas les clés Signal — le Double Ratchet rend
> une sauvegarde de clés inopérante.

| # | ticket |
|---|---|
| **3.1** | **Format d'archive** : blocs chiffrés, ajoutés au fil de l'eau. ⚠️ Réserver la place des médias dès maintenant, sinon tout sera à reprendre. |
| **3.2** | **Clé maîtresse aléatoire**, enveloppée. Changer de secret ne ré-enveloppe que la clé, jamais l'archive. |
| **3.3** | **Serrure 1 — le trousseau de l'appareil** : WebAuthn PRF côté web, Keystore/Keychain côté mobile. **L'utilisateur ne voit aucune clé.** |
| **3.4** | **Dépôt incrémental**, à chaque lot de messages lus. ⚠️ Pas au moment du changement de téléphone : un téléphone cassé n'exporte rien. |
| **3.5** | **Restauration** sur appareil neuf. ⚠️ L'archive ne restaure **pas** l'identité Signal : le nouvel appareil en publie une neuve, et les correspondants voient « la clé a changé ». D'où le lot 1 en prérequis. |
| **3.6** | **Écran** : dire au moment de la création ce qui est sauvegardé, et ce qui est perdu si le trousseau ne suit pas. Pas dans les conditions d'utilisation. |
| **3.7** | ⛔ **ABANDONNÉ (user, 23/09) : pas de réécriture de l'authentification.** Donc **pas de serrure dérivée du mot de passe**. Voir la note ci-dessous — ce n'est pas neutre. |
| **3.8** | **Clé de récupération affichée, EN OPTION.** La compensation de l'abandon de 3.7, et elle est quasi gratuite : la clé maîtresse s'enveloppe autant de fois qu'on veut. Personne ne la subit, et le cas « tout est perdu » cesse d'être fatal. |

---

### ⚠️ Ce que l'abandon de 3.7 coûte — à assumer explicitement

Sans serrure dérivée du mot de passe, **l'archive n'a qu'une serrure** : le
trousseau de l'appareil.

Si le trousseau ne suit pas, **l'historique est perdu** :

- passage Android → iPhone ;
- synchronisation du trousseau désactivée ;
- téléphone perdu sans sauvegarde système.

Le raisonnement du user se tient : le mot de passe est **haché** en base
(bcrypt), et l'objectif — que les messages ne soient jamais stockés en clair —
est déjà atteint sans toucher à l'authentification.

⚠️ **Une précision, parce qu'elle porte sur la décision** : le hachage au repos
ne couvrait pas la préoccupation d'origine. Le mot de passe **transite en clair
par le serveur à chaque connexion** — un journal, un vidage mémoire, un serveur
compromis le voient à cet instant. C'est ce que la dérivation à deux sels
aurait supprimé.

Mais cela ne change **rien** au chiffrement des messages, qui est le sujet.
La décision tient ; c'est son périmètre qu'il fallait nommer.

➜ **Le ticket 3.8 est donc la vraie compensation**, et je le recommande.

---

## 7. LOT 4 — Le client mobile

| # | ticket |
|---|---|
| **4.1** | **Choix de bibliothèque.** Décision structurante : le web utilise `@privacyresearch/libsignal-protocol-typescript`, non maintenu depuis 3 ans. Le mobile n'a pas à hériter de ce choix. À évaluer avant d'écrire une ligne. |
| **4.2** | Coffre : Android Keystore / iOS Keychain. Le mobile a ici **mieux** que le web — du matériel. |
| **4.3** | Parité : périmètre, bannière, avertissement de clé, codes de sécurité. |
| **4.4** | **Multi-appareil simultané** web + mobile. Chaque appareil a son identité et reçoit sa propre enveloppe — le modèle le permet déjà. À éprouver, pas à concevoir. |

---

## 8. LOT 5 — Dette de fond

| # | ticket |
|---|---|
| **5.1** | 🔴 **La bibliothèque non maintenue** — le risque principal de tout l'édifice, écrit en tête de `e2ee-service.ts`. Aucune correction de sécurité depuis 3 ans, et **aucun portage navigateur officiel de libsignal n'existe**. À surveiller, à documenter, à réévaluer. |
| **5.2** | **CSP stricte.** Le coffre chiffré protège contre l'exfiltration des clés, **pas** contre un script hostile qui s'en sert sur place. La CSP est la défense qui manque. |
| **5.3** | Recherche dans les messages chiffrés — côté client uniquement, sur le cache. |
| **5.4** | Chiffrement des médias (remis par décision du user). |

---

## 9. Hors périmètre, et pourquoi

| | raison |
|---|---|
| **Groupes** | demanderait les Sender Keys — un second protocole, pas une extension du premier |
| **Centre d'appels, comptes API, agents** | la liste blanche `TYPES_PERSONNELS = [0]` les exclut par construction, et c'est voulu : ces conversations doivent rester lisibles par l'organisation |
| **Appels chiffrés** | déjà chiffrés par WebRTC/DTLS-SRTP ; un autre sujet |

---

## 10. Ordre proposé

```
  LOT 0 ──────────────────────────────▶ obligatoire avant production
    │
    ├──▶ LOT 2  (rétention, en parallèle, indépendant)
    │
    └──▶ LOT 1  (codes de sécurité)
            │
            └──▶ LOT 3  (archive)
                    │
                    └──▶ LOT 4  (mobile)

  LOT 5 : continu
```

**Les trois décisions sont prises** (user, 23/09/2026) :

| ticket | décision |
|---|---|
| **0.1** | La traduction est **déjà** sur l'appareil par défaut. Il reste à la **forcer** dans un fil chiffré, quel que soit le réglage. |
| **1.4** | **Modèle WhatsApp** : on avertit, on ne bloque jamais. |
| **3.7** | **Pas de réécriture de l'authentification.** Une seule serrure sur l'archive, plus la clé de récupération en option (3.8). |

➜ **En cours : lot 0.**

---

## 12. Journal des décisions

| date | décision | par |
|---|---|---|
| 21/09 | Périmètre : personnel ↔ personnel uniquement | user |
| 21/09 | Anciens messages lisibles + bannière « à partir d'ici, chiffré » | user |
| 21/09 | Changement de clé : avertir, ne pas bloquer | user |
| 21/09 | Les messages en clair restent en cache | user |
| 21/09 | Chiffrement des médias : remis | user |
| 23/09 | Sauvegarder les **messages**, pas les clés Signal | analyse |
| 23/09 | Codes de sécurité : modèle WhatsApp | user |
| 23/09 | Pas de réécriture de l'authentification | user |
