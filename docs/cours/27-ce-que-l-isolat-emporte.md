# Chapitre 27 — Ce que l'isolat emporte

> **Où nous en sommes.** 04/10/2026. Le téléphone envoie des médias chiffrés
> depuis le lot C (chapitre 25). Depuis le 03/10 au soir, l'écran montre
> aussi une vignette et un pourcentage pendant l'envoi. Ce chapitre explique
> pourquoi cette petite amélioration a cassé l'envoi, et comment on l'a réparé.
>
> Mobile seul : commit `b5f5b5e`, branche `feat/chip-appel-callstyle`.

---

## 1. Le symptôme

Sur le téléphone, envoyer une photo dans un fil chiffré affiche :

> Envoi impossible : Invalid argument(s): Illegal argument in isolate message:
> object is unsendable - Library:'dart:async' Class: _Future

suivi d'une longue chaîne :

```
<- Instance of '_ChatScreenState'
<- _ChatScreenState._pickAndSendFile
<- Instance of 'IconButton'
<- … (tout l'arbre des widgets)
```

Rien n'est parti : ni le fichier, ni le message.

## 2. Rappel : pourquoi un isolat

Le chiffrement d'un fichier est écrit en **Dart pur** (`pointycastle`, AES-GCM
par blocs de 64 Ko, chapitre 23). Sur une vidéo de 50 Mo, il occupe le
processeur plusieurs secondes. S'il tournait sur le fil de l'écran, l'écran
serait figé pendant tout ce temps.

On le lance donc dans un **isolat** : un second fil d'exécution qui a **sa
propre mémoire**. Comme les deux mémoires sont séparées, tout ce que l'isolat
doit utiliser lui est **envoyé**, en copie.

```dart
final f = await Isolate.run(() => chiffrerFichier(octets));
```

Ici, on envoie une **fermeture** : `() => chiffrerFichier(octets)`. Il faut
donc envoyer aussi tout ce dont cette fermeture a besoin.

## 3. Le piège : une fermeture n'emporte pas que ses variables

Intuitivement, la fermeture ne parle que de `octets`. On s'attend donc à ce
que seuls les octets voyagent.

**Ce n'est pas ce que fait la machine virtuelle Dart.** Une fonction qui crée
plusieurs fermetures range toutes les variables capturées dans **un seul
objet**, le **contexte**. Chaque fermeture pointe vers ce contexte entier, et
le contexte pointe vers celui de la fonction englobante.

Voici la fonction d'envoi après le 03/10 au soir :

```dart
static Future<Message> envoyer({ …, void Function(double)? onProgression }) async {
  final octets = fichier.bytes;
  …
  final f = await Isolate.run(() => chiffrerFichier(octets));   // fermeture 1
  final envoye = await medias.upload(
    …,
    onProgress: (envoyes, total) => onProgression(envoyes / total), // fermeture 2
  );
```

- La fermeture 1 capture `octets`.
- La fermeture 2 capture `onProgression`.
- Les deux variables vivent donc dans **le même contexte**.

Quand on envoie la fermeture 1, son contexte part avec elle, **y compris
`onProgression`**.

Il faut alors suivre la chaîne :

| Objet envoyé | Ce qu'il tient |
|---|---|
| `onProgression` | une fermeture créée dans `_pickAndSendFile` |
| son contexte | `this`, c'est-à-dire `_ChatScreenState` |
| `_ChatScreenState` | l'arbre des widgets, des contrôleurs… et un `Future` |
| `_Future` | **interdit à l'envoi** |

C'est exactement la chaîne affichée par l'erreur, lue de bas en haut.

## 4. Pourquoi ça marchait avant

Le lot C (`05c7c3e`) avait déjà ce même `Isolate.run`. Mais à ce moment-là,
`envoyer` ne créait **aucune autre fermeture** : le contexte ne contenait que
`octets`.

Le commit `0de303a` (03/10) a ajouté le suivi de progression. Ça a suffi à
introduire la deuxième fermeture, donc à faire entrer l'écran dans le contexte.

**Personne n'a touché à la ligne du chiffrement**, et pourtant c'est elle qui
a cassé. C'est ce qui rend ce défaut traître : le code fautif est **voisin** de
la modification.

## 5. Le correctif : un contexte qui ne contient que les paramètres

On sort l'appel à l'isolat dans une **fonction de haut niveau**, dans
`lib/services/e2ee/e2ee_media.dart` :

```dart
Future<FichierChiffre> chiffrerHorsDuFil(Uint8List clair) =>
    Isolate.run(() => chiffrerFichier(clair));

Future<Uint8List> dechiffrerHorsDuFil(Uint8List chiffre,
    {required String cle, required String empreinte, required int taille}) =>
  Isolate.run(() => dechiffrerFichier(chiffre,
      cle: cle, empreinte: empreinte, taille: taille));
```

Dans ces fonctions, la fermeture a pour seul contexte **les paramètres de la
fonction**. Rien d'autre ne peut s'y glisser, quel que soit l'appelant.

Ces fonctions sont utilisées à trois endroits :

| Endroit | Avant |
|---|---|
| Envoi (`e2ee_media_envoi.dart`) | **cassé** (le symptôme) |
| Ouverture (`e2ee_media_ouverture.dart`) | sain, mais par chance |
| Visionneur de vue unique (`visionneur_vue_unique.dart`) | **défaut en germe** |

Le visionneur appelait `Isolate.run` **dans une méthode d'un `State`**, à côté
de `setState(() => _media = media)`. Ce `setState` capture `this`. Le
visionneur était donc exposé au même défaut.

## 6. Ce qui a été prouvé

Le test `test/e2ee_media_isolat_test.dart` reproduit la situation :

1. **l'ancienne forme** : un `Isolate.run` sur place, à côté d'un rappel qui
   tient un objet contenant un `Future`. Résultat : `ArgumentError`, la même
   erreur que sur le téléphone ;
2. **la nouvelle forme** : même voisinage, mais en passant par
   `chiffrerHorsDuFil`. Le fichier est chiffré, puis déchiffré à l'identique ;
3. `dechiffrerHorsDuFil` rend bien `FichierInvalide` sur une empreinte fausse.

Les tests existants des médias chiffrés passent aussi : 21 sur 21.

**Pas encore vérifié** : un vrai envoi depuis le téléphone, avec l'APK construit
par la CI.

## 7. À retenir

- Un `Isolate.run` emporte **le contexte entier** de la fonction qui l'appelle,
  pas seulement les variables que la fermeture cite.
- Ajouter une fermeture **voisine** peut casser un `Isolate.run` qui n'a pas
  bougé.
- Règle du projet : **jamais d'`Isolate.run` écrit sur place**. Toujours passer
  par une fonction de haut niveau qui ne reçoit que des données simples
  (octets, chaînes, nombres).
- L'erreur affiche **le chemin** de l'objet refusé. Il se lit de bas en haut,
  et désigne directement le coupable.
