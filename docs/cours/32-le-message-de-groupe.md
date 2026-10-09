# Chapitre 32 — Le message de groupe, et la signature qui disait l'inverse

> **Où nous en sommes.** 09/10/2026. Le chapitre 31 a choisi le **trousseau de
> groupe**. Ce chapitre couvre le **lot 1** : le module qui chiffre, signe,
> vérifie et déchiffre un message de groupe, écrit **deux fois** (web et
> mobile), et prouvé par des vecteurs croisés. Aucun écran, aucune route : la
> brique seule, avant tout le reste.
>
> Web `src/services/e2ee-groupe.ts`, mobile `lib/services/e2ee/e2ee_groupe.dart`,
> banc `STAGE-WEB/scripts/e2ee-groupe-vecteur.mjs`, outil
> `alanya/tool/vecteur_groupe_mobile.dart`, test `alanya/test/e2ee_groupe_test.dart`.

---

## 1. Pourquoi commencer par là

Tout le chantier repose sur une promesse : un message chiffré par le web se
lit sur le téléphone, et inversement. Si cette promesse ne tient pas, rien de
ce qu'on construira au-dessus ne marchera — et on ne le découvrira qu'à la
fin, sur un vrai téléphone, sans savoir où chercher.

D'où la règle : **la brique cryptographique d'abord, prouvée seule**, avant
toute route, table ou écran.

## 2. Ce que fait le module

```
corps = base64( 0x01 | nonce(12) | chiffré + étiquette GCM | signature(64) )
```

| Étape | Rôle |
|---|---|
| **AES-256-GCM** avec la clé de la version | le secret : seul un membre lit |
| **nonce de 12 octets tiré au hasard** | jamais deux fois le même avec la même clé |
| **données associées** (groupe, message, version, expéditeur, appareil) | le chiffré est collé à **sa** place |
| **signature XEdDSA** de l'appareil expéditeur | aucun membre ne peut écrire au nom d'un autre |

Le **contenu** chiffré est la charge v2 habituelle : réponse, contact, média,
modification marchent sans rien changer.

### Le séparateur des données associées

Les champs sont collés avec `\n` :

```
alanya-groupe-v1\n<groupe>\n<message>\n<version>\n<expéditeur>\n<appareil>
```

Sans séparateur, deux contextes différents pourraient donner la même suite
d'octets une fois collés (`"ab" + "c"` et `"a" + "bc"`). Les champs sont des
UUID et des entiers : ils ne contiennent jamais `\n`, et le module **refuse**
un champ qui en contiendrait.

### La signature d'abord

On vérifie la signature **avant** de déchiffrer. On ne fait rien du contenu
d'un inconnu, pas même le déchiffrer.

Et on la vérifie avec la clé d'identité **déjà connue** de l'appareil
expéditeur (celle de la session à deux), jamais avec une clé redemandée au
serveur à cette occasion : un serveur malveillant pourrait en fournir une
fausse.

## 3. Le piège : `verifySignature` dit l'inverse sur le web

En écrivant les deux modules, on a lu le code des deux bibliothèques Signal.
Elles ont une fonction au **même nom**, avec un **sens opposé** :

| Bibliothèque | `Curve.verifySignature` rend `true` quand… |
|---|---|
| mobile (`libsignal_protocol_dart`) | la signature est **valide** |
| web (`@privacyresearch/libsignal-protocol-typescript`) | la signature est **invalide** |

Côté web, la fonction relaie telle quelle `curve25519.verify`, dont le code
source avoue lui-même :

> « The fact that verify returns true when a signature is invalid could be
> confusing. »

### Ce qui se serait passé

Un code « naturel » côté web :

```ts
if (!curve.verifySignature(cle, message, signature)) throw …
```

aurait **accepté toutes les fausses signatures** et **refusé toutes les
vraies**. Pire : on aurait vu les messages légitimes refusés, on aurait
« corrigé » en retirant la vérification… et l'usurpation serait passée.

### La parade, en trois couches

1. **Un nom sans ambiguïté** : les deux modules exposent `signatureValide()`.
   La négation n'existe qu'à **un seul endroit**, dans le module web, avec un
   commentaire qui dit pourquoi.
2. **Un test qui prouve le sens** : le banc vérifie à la fois qu'un message
   **valide est accepté** et qu'une signature **falsifiée est refusée**. L'un
   sans l'autre ne prouve rien : une fonction qui refuse tout passerait le
   second test.
3. **Les vecteurs croisés** : la fausse signature est refusée **des deux côtés**.

> **Leçon.** Deux fonctions de même nom, dans deux bibliothèques, ne veulent pas
> forcément dire la même chose. Sur une fonction de sécurité, **lisez son
> code**, et testez **les deux** issues — le oui et le non.

## 4. Les vecteurs croisés

Comme pour les médias (chapitre 23), chaque côté produit un **vecteur** que
l'autre doit lire :

| Vecteur | Produit par | Vérifié par |
|---|---|---|
| `vecteur_groupe_web.json` | le banc web (`--ecrire`) | le test Dart |
| `vecteur_groupe_mobile.json` | `dart run tool/vecteur_groupe_mobile.dart` | le banc web |

Chaque vecteur contient une clé de groupe et un nonce **fixés**, un contexte, un
clair (avec accents et émoji), le message chiffré et signé, la clé publique
d'identité qui l'a signé, et une charge trousseau.

Ce que chaque côté vérifie sur le vecteur de l'**autre** :

| Vérification | Ce qu'elle prouve |
|---|---|
| il **lit** le message | même chiffrement, même format, signatures compatibles |
| il **refuse** la version falsifiée | le sens de la signature est le bon |
| avec le même nonce, il produit le **même chiffré** | même AES-GCM, mêmes données associées, octet pour octet |
| il écrit la **même charge trousseau** | même JSON, même ordre des champs |

⚠️ La signature, elle, n'est **pas** comparée : XEdDSA est **aléatoire**, deux
signatures du même message diffèrent. On vérifie qu'elle est valide, pas
qu'elle est identique.

## 5. Les refus prouvés

| Tentative | Refusée |
|---|---|
| signature falsifiée | ✅ |
| signé par un autre appareil | ✅ |
| déplacé vers un autre message, un autre groupe | ✅ |
| attribué à un autre expéditeur | ✅ |
| servi sous une autre version | ✅ |
| mauvaise clé de groupe, chiffré altéré | ✅ |
| trousseau rattaché à un autre groupe | ✅ |
| trousseau qui **remplace** une clé déjà connue | ✅ |

Le dernier mérite un mot : un trousseau peut **ajouter** des versions, jamais
en **remplacer**. Sinon, un faux trousseau (relayé par un serveur
malveillant) pourrait rendre illisibles les anciens messages, ou les rendre
lisibles par quelqu'un d'autre.

## 6. Ce qui a été prouvé, et ce qui reste

- Web : 20 vérifications (banc, vrais modules), dont les 4 sur le vecteur du
  mobile ; `tsc` sans erreur.
- Mobile : 9 tests, dont les 4 sur le vecteur du web ; suite complète 372 ✓ ;
  analyse sans remarque.
- **Pas encore fait** : tout le reste — serveur, envoi, réception, trousseau
  entre appareils. C'est l'objet des lots 2 à 8.

## 7. À retenir

- Prouver la brique cryptographique **seule** et **des deux côtés**, avant de
  bâtir dessus.
- Les **données associées** collent un chiffré à sa place ; un séparateur
  évite les collages ambigus.
- **Signature d'abord**, avec la clé déjà connue.
- Une fonction de sécurité se **lit**, et se teste dans ses **deux** issues.
- Un trousseau **ajoute**, il ne **remplace** jamais.
