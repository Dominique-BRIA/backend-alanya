# Chapitre 39 — Les boîtes permanentes : la clé sans administrateur en ligne

> **Où nous en sommes.** 10/10/2026. Demande du user : « je voudrais qu'il n'y
> ait pas besoin qu'un admin soit connecté pour qu'il ait les clés ». Le
> chapitre 37 savait redemander une clé perdue… mais il fallait qu'un
> administrateur soit en ligne pour répondre. Ce chapitre supprime cette
> attente, en un seul lot : serveur, web, mobile, tests.
>
> Backend `00b108f`, web `2d92272`, mobile `399baac`. Tout est déployé ; l'APK
> se reconstruit sur la CI.

---

## 1. Le problème : une enveloppe ne se lit qu'une fois

Jusqu'ici, la clé du groupe voyageait dans des **enveloppes** Signal : une par
appareil destinataire, chiffrée avec la session à deux, **consommée** à la
lecture (le rochet avance, l'enveloppe est marquée remise).

C'est très bien… tant que tout se passe bien. Le cas réel de « Test E2EE » :

1. Døms active le chiffrement à 09:52 ;
2. le téléphone de domsbria tourne encore l'**ancienne application** ;
3. elle reçoit l'enveloppe du trousseau, ne la comprend pas, **la traite comme
   un message** (l'aperçu « G1{"v":1,"type":"trousseau"… » dans la liste) ;
4. l'enveloppe est consommée : la clé est perdue.

Le chapitre 37 a ajouté la **demande** : « renvoyez-moi la clé ». Mais une
demande attend une **réponse**, et seul un appareil allumé répond. Si Døms
n'est pas connecté, domsbria reste sur « en attente de la clé du groupe ».

> 🎓 **Leçon.** Un message à usage unique est parfait pour la confidentialité
> persistante… et fragile pour une **clé** dont on aura besoin plus tard. Ce
> qui doit pouvoir être **relu** ne doit pas voyager **seulement** dans un
> canal qui se consomme.

## 2. L'idée : une boîte qui reste sur le serveur

À chaque distribution, l'administrateur dépose, **en plus** des enveloppes,
une **boîte permanente** par appareil destinataire :

- elle contient le **trousseau entier** (toutes les versions) ;
- elle est scellée pour la **clé d'identité de l'appareil** destinataire — le
  serveur la garde mais ne peut pas l'ouvrir ;
- elle **reste** : l'appareil peut la relire autant de fois qu'il veut, sans
  personne en ligne ;
- chaque nouvelle distribution la **remplace** ;
- elle est **supprimée** quand le membre quitte ou est exclu du groupe.

Une ligne en base par (groupe, membre, appareil) : la table `e2ee_boites`.

## 3. Le sceau : ECIES, sans session

On ne peut pas utiliser une session Signal : elle se consomme. On scelle
donc « à l'ancienne », avec une construction **ECIES** :

```
éphémère  ← nouvelle paire X25519, jetée après usage
secret    ← X25519(éphémère.privée, identité_destinataire.publique)
clé       ← HKDF-SHA256(secret, sel = 32 zéros, info = "alanya-boite-v1")
chiffré   ← AES-256-GCM(clé, nonce 12 octets, trousseau, aad)
signature ← XEdDSA(identité_déposant.privée, aad | éphémère | nonce | chiffré)

boîte = base64( 0x01 | éphémère (33) | nonce (12) | chiffré | signature (64) )
```

Le destinataire refait le même secret de l'autre côté :
`X25519(identité_destinataire.privée, éphémère.publique)`.

### Pourquoi une AAD aussi longue ?

```
"alanya-boite-v1\n" + groupe + "\n" + destinataire + "\n" + appareil
                    + "\n" + déposant + "\n" + appareil_déposant
```

L'AAD (données associées) n'est pas chiffrée mais elle est **authentifiée** :
si on change une seule lettre, le déchiffrement échoue. Elle **lie** la boîte
à son contexte. Sans elle, un serveur malveillant pourrait :

- copier la boîte du groupe A dans la ligne du groupe B ;
- présenter la boîte d'Alice comme venant de Bob.

Avec elle, la boîte ne s'ouvre **que** dans le contexte où elle a été scellée.

### Pourquoi signer, alors qu'AES-GCM authentifie déjà ?

GCM prouve que la boîte n'a pas été **modifiée** — pas **qui** l'a faite.
N'importe qui connaissant ma clé publique d'identité (le serveur la publie !)
peut sceller une boîte pour moi. La signature XEdDSA, vérifiée **avant** de
déchiffrer avec l'identité **déjà connue** du déposant, prouve l'auteur.

## 4. Qui a le droit de déposer ?

Deux gardes, l'une derrière l'autre :

| Où | Règle |
|---|---|
| Serveur (`PUT /api/e2ee/boites`) | un administrateur dépose pour tous les membres actifs ; un simple membre seulement pour **lui-même** (403 `ADMIN_REQUIS`) |
| Appareil qui relève | accepte une boîte seulement si le déposant est **administrateur** du groupe (y compris la règle du « premier arrivé ») ou **moi-même** |

⚠️ La deuxième garde est la vraie : on ne fait **pas** confiance au serveur.
Un test le prouve : on glisse directement dans le faux serveur une boîte
correctement scellée et signée par Bob, simple membre — Carole l'**écarte**.

## 5. L'ordre de récupération

Quand une clé manque, l'appareil essaie, dans cet ordre :

1. **local** — la clé est déjà rangée ;
2. **ma boîte** — relue tout de suite, personne n'a besoin d'être en ligne ;
3. **ma copie personnelle** (chapitre 34) — si j'ai mon archive ouverte ;
4. **la demande** (chapitre 37) — à mes autres appareils et aux administrateurs.

Les trois dernières étapes sont regroupées derrière un **frein de 30 secondes**
par groupe : un fil de 200 messages illisibles ne déclenche pas 200 appels.

Un nouveau téléphone (`restaurerTous`) relève **toutes** ses boîtes d'un coup,
puis ses copies.

## 6. Web et mobile : deux jumeaux, des vecteurs croisés

Le scellement existe deux fois : TypeScript (`e2ee-groupe.ts`, WebCrypto +
libsignal) et Dart (`e2ee_groupe.dart`, pointycastle + libsignal). Pour être
sûr qu'ils parlent **la même langue**, on fabrique des **vecteurs** :

- `STAGE-WEB/scripts/e2ee-boite-vecteur.mjs --ecrire` scelle une boîte avec
  un éphémère et un nonce **imposés**, et l'écrit dans
  `alanya/test/donnees/vecteur_boite_web.json` ;
- `alanya/tool/vecteur_boite_mobile.dart` fait de même côté Dart ;
- chacun **ouvre** la boîte de l'autre, et vérifie qu'avec les mêmes entrées
  il produit **exactement** les mêmes octets.

Résultat : 12 ✓ côté web, 3 ✓ côté Dart.

> 🎓 **Leçon.** Deux implémentations « correctes » d'une même spécification
> peuvent ne pas s'entendre (un sel oublié, un octet de préfixe en plus sur la
> clé publique…). Un vecteur fixe, échangé dans les deux sens, l'attrape en
> une seconde — bien avant le téléphone du user.

## 7. Les erreurs rencontrées, et leurs solutions

### a) `prisma generate` : EPERM

Après l'ajout du modèle `E2eeBoite`, `prisma generate` échouait :
`EPERM: operation not permitted, rename … query_engine-windows.dll.node`.

**Cause.** Sous Windows, un fichier chargé par un processus est **verrouillé**.
Le serveur `next dev` et le WebSocket tournaient et avaient chargé le moteur
Prisma.

**Solution.** Arrêter les deux serveurs, régénérer, les relancer.

### b) Un test qui devenait « trop vert »

Le test mobile « clé perdue… l'administratrice la renvoie » s'est mis à
échouer. Il vérifiait que la clé revient **par la demande** — or elle revenait
maintenant **avant**, par la boîte.

**Solution.** Ce test-là vise la demande : on supprime les boîtes de Carole
avant, pour qu'il continue à prouver ce qu'il doit prouver. Le nouveau cas
« sans administrateur » a son propre test.

> 🎓 **Leçon.** Quand on ajoute un chemin plus court, les anciens tests
> peuvent passer **par lui** sans qu'on le voie. Chaque test doit fermer les
> autres portes pour prouver **la sienne**.

### c) Le banc web : 4 versions au lieu de 1 000, puis 0

Banc administrateur, étape ⑨ (renvoi par l'admin) : Dave retrouvait
**4** versions au lieu de 1 000.

**Cause.** Il relisait une **ancienne** boîte, déposée avant que le trousseau
ne grossisse. **Solution** : supprimer les boîtes de Dave en ⑨, qui teste le
renvoi par l'admin, pas la boîte.

Étape ⑩ (aucun admin en ligne) : **0** version.

**Cause.** Le **frein de 30 secondes** : ⑨ venait de tenter une restauration
pour ce groupe, la suivante était ignorée. Et la vérification de l'historique
passait quand même… grâce au **cache** des messages déjà déchiffrés.

**Solution.** Attendre 31 secondes avant ⑩, et vérifier **les versions
rangées avant** l'historique.

### d) Le banc mobile ↔ web : la boîte n'était pas la seule source

Le banc supprimait l'enveloppe de Wes pour prouver qu'il lisait grâce à la
boîte. Mais son navigateur, ouvert, avait pu **relever l'enveloppe avant** sa
suppression : le test pouvait passer sans la boîte.

**Solution.** Retirer aussi la clé locale et la copie de Wes ; vérifier
qu'il n'a **plus rien** ; puis seulement, lui faire lire T1.

## 8. Les preuves

| Banc | Résultat |
|---|---|
| Serveur (`groupe-chiffre-banc.mjs`, ⑨bis boîtes) | vert |
| Vecteurs croisés web ↔ mobile | 12 ✓ / 3 ✓ |
| Web administrateur — ⑩ Alice **fermée**, Dave sans clé ni copie : ses 1 000 versions viennent de la boîte, aucune enveloppe | TOUT EST VERT |
| Mobile ↔ web — Wes sans enveloppe, sans clé, sans copie : lit T1 grâce à la boîte du mobile | 19 ✓ |
| Suite mobile complète | 410 ✓ |
| Production | table `e2ee_boites` présente ; `GET /api/e2ee/boites` sans session → 401 |

## 9. Ce qui reste

- **Les boîtes ne naissent qu'aux distributions suivantes.** Pour le groupe
  « Test E2EE », un administrateur doit appuyer **une fois** sur « Changer la
  clé du groupe » pour que chaque appareil reçoive la sienne.
- **Le téléphone doit avoir le nouvel APK** pour relever ses boîtes.
- **Un cas rare demeure** : un membre dont **tous** les appareils ont été
  remplacés avant qu'aucun n'ouvre sa boîte, sans copie personnelle. La boîte
  est scellée pour un appareil qui n'existe plus : il faudra un administrateur
  en ligne pour lui en déposer une nouvelle.
