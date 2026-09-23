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

### 🔴 E-01 — La traduction exfiltre le clair d'un fil chiffré

**`src/app/api/translate/route.ts`**

Le relais de traduction prend le texte du client, l'envoie à un fournisseur
tiers (Azure, DeepL, Google), et **le met dans un cache partagé**.

Un utilisateur qui appuie sur « traduire » dans une conversation chiffrée
envoie donc son message :

1. à notre serveur ;
2. à Microsoft ou Google ;
3. dans un cache lisible par d'autres comptes.

**L'écran affiche « chiffré » pendant ce temps.** C'est le pire genre de fuite :
celle que l'utilisateur déclenche lui-même en croyant être protégé.

⚠️ Ce n'est pas un défaut du relais — il fait exactement ce pour quoi il a été
écrit. C'est un défaut de **périmètre** : personne n'a rapproché les deux
fonctionnalités.

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
| **0.1** | **Interdire la traduction serveur sur un fil chiffré.** Le client refuse, et l'écran explique pourquoi. Le serveur refuse aussi — une garde côté client seul se contourne. | web + `translate/route.ts` |
| **0.2** | **Traduction sur l'appareil** pour les fils chiffrés, ou rien. Un moteur local existe déjà côté navigateur (mentionné dans le relais). Sinon : bouton absent, pas grisé sans explication. | web |
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
| **1.4** | **Décider ce qui se passe quand la clé change APRÈS vérification.** C'est le seul cas où bloquer se défend : l'utilisateur avait affirmé connaître cette clé. Aujourd'hui on avertit sans bloquer — c'est bon par défaut, discutable après vérification. |
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
| **3.7** | **Serrure 2 — le mot de passe du compte.** ⚠️ Exige de séparer les dérivations : aujourd'hui `login/route.ts` reçoit le mot de passe **en clair**. Refonte connexion + inscription + changement de mot de passe, web **et** mobile. À décider séparément. |

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

**Trois décisions vous appartiennent, et elles bloquent :**

1. **Ticket 0.2** — traduction sur l'appareil pour les fils chiffrés, ou bouton absent ?
2. **Ticket 1.4** — bloquer, ou seulement avertir, quand la clé d'un correspondant **vérifié** change ?
3. **Ticket 3.7** — réécrit-on l'authentification pour la seconde serrure, ou reste-t-on sur le trousseau seul ?

**Je commencerais par le lot 0.1–0.3** : ce sont les trois points qui font
qu'aujourd'hui, le mot « chiffré » affiché à l'écran n'est pas tenu.
