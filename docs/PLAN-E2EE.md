Je m# Plan d'implémentation — Chiffrement de bout en bout

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
| Lot 0 — fuites et manques (traduction, push, aperçu, médias, pré-clés) | ✅ |
| Lot 1 — codes de sécurité | ✅ |
| Lot 2 — purge des enveloppes (2.3 reporté sur mesure) | ✅ |
| **Lot 3 — archive chiffrée, trois serrures** | ✅ |

**Bancs** : `e2ee-banc.mjs`, `e2ee-nonfuite.mjs`, `e2ee-purge.mjs` (backend),
`e2ee-web.mjs`, `e2ee-empreinte.mjs` (modules navigateur),
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
| **2.1** | ✅ **FAIT.** `purgeEnveloppesChiffrees()` dans `ws-server.mjs`, au démarrage puis toutes les heures — même cadence que la purge des statuts. |
| **2.2** | ✅ **FAIT, et en DEUX seuils, pas un.** Les **acquittées** partent à 30 jours : `remis_le` n'est posé qu'après un déchiffrement réussi, donc ce délai est une **marge**, pas un besoin. Les **jamais relevées** partent à 90 jours — trois fois plus long, parce qu'ici on supprime un message que le destinataire n'a PAS lu : se tromper coûte un message, pas quelques octets. 🐛 Ce second cas s'accumulait **sans aucune limite** ; les bancs le nettoyaient, la production non. |
| **2.3** | ⏸️ **REPORTÉ, sur mesure.** ⚠️ Le plan annonçait « 25 % d'économie » : c'était 25 % du **chiffré**, soit **10 % de la ligne** — le reste est fait d'UUID, d'horodatages et d'index. Mesuré après la purge : un utilisateur **très actif** (200 msg/j) garde ~2,6 Mo d'enveloppes, dont `bytea` retirerait **264 Ko**. La purge ayant borné la table, ce changement touche le chemin chaud du chiffrement et impose au mobile de suivre, pour un gain devenu marginal. À reprendre si le volume le justifie un jour. |
| **2.4** | ✅ **VÉRIFIÉ — rien à faire.** `DELETE /api/account` fait un vrai `prisma.user.delete`, et les **sept** clés étrangères des tables `e2ee_*` sont bien en `ON DELETE CASCADE` **dans la base** (contrôlé par `information_schema`, pas dans le schéma Prisma). Identités, pré-clés signées, pré-clés uniques et enveloppes partent avec le compte. |

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
| **3.7** | ✅ **Serrure 2 — le mot de passe du compte, SANS réécrire l'authentification.** Le client dérive `vaultKey = KDF(mdp, sel_coffre)` **au moment où l'utilisateur tape son mot de passe** — connexion, inscription, changement. Cette valeur ne part jamais. La route de connexion, elle, ne change pas. |
| **3.7b** | ⚠️ **La propriété qu'on n'obtient PAS**, et il faut l'écrire dans le produit : le serveur reçoit toujours le mot de passe en clair à la connexion. Il **pourrait** donc dériver la clé du coffre s'il était compromis ou malveillant. Cette serrure protège l'archive **au repos**, pas contre nous. Les deux autres serrures, elles, n'ont pas cette limite. |
| **3.8** | **Serrure 3 — clé de récupération affichée, en option.** Tirée au sort, montrée une fois, en mots plutôt qu'en hexadécimal. La seule qui survive à un « mot de passe oublié ». |
| **3.9** | **Le rattrapage** : les trois serrures n'enveloppent pas toutes la clé au même moment. Il faut pouvoir en ajouter une plus tard — l'utilisateur active l'archive une semaine après sa connexion, et on n'a plus son mot de passe en mémoire. ⚠️ Redemander le mot de passe à ce moment-là est normal ; le garder en mémoire ne l'est pas. |

---

### Les trois serrures, et ce que chacune vaut

> **Décision du user, 23/09/2026 : les trois.** Pas de réécriture de
> l'authentification, mais la serrure du mot de passe quand même.

**Les deux instructions sont compatibles**, et le détail compte :

| serrure | l'utilisateur doit | protège au repos | protège contre NOUS |
|---|---|---|---|
| trousseau de l'appareil | rien (Face ID) | ✅ | ✅ |
| mot de passe du compte | s'en souvenir | ✅ | ❌ |
| clé de récupération | la garder | ✅ | ✅ |

La serrure du mot de passe se pose **sans toucher à la connexion** : le client
dérive la clé localement au moment où l'utilisateur tape son mot de passe, et
ne l'envoie pas. La route de connexion continue de recevoir le mot de passe
comme aujourd'hui.

⚠️ **D'où la colonne rouge.** Le serveur voyant le mot de passe à la connexion,
il pourrait dériver la même clé s'il était compromis. Cette serrure-là est un
**confort de récupération**, pas une garantie zero-knowledge — et le produit
doit le dire, pas le laisser croire.

➜ **C'est précisément pourquoi avoir les trois est la bonne décision.** Chacune
couvre le trou des autres :

- le trousseau ne suit pas d'Android à iPhone → **le mot de passe** ;
- mot de passe oublié et réinitialisé → **la clé de récupération** ;
- serveur compromis → **les deux autres restent hors de sa portée**.

⚠️ **La porte de sortie reste ouverte** : le jour où l'authentification serait
réécrite (dérivation à deux sels), la serrure 2 gagne la colonne rouge **sans
rechiffrer l'archive** — on ré-enveloppe la clé maîtresse, rien d'autre. C'est
tout l'intérêt de la clé maîtresse tirée au sort.

---
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
| **3.7** | **Les trois serrures**, dont le mot de passe — mais **sans** réécrire l'authentification. La serrure 2 protège au repos, pas contre un serveur compromis ; le produit doit le dire. |

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
| 23/09 | **Les TROIS serrures**, dont celle du mot de passe — sans réécrire l'authentification | user |
| 23/09 | Purge en **deux** seuils : 30 j acquittées, 90 j jamais relevées | analyse |
| 23/09 | `corps` en `bytea` reporté : 10 % de la ligne, pas 25 % — marginal une fois la table bornée | analyse |
