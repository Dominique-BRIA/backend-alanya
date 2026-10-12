# Chapitre 47 — Ne jamais tourner sans chiffre

> **Où nous en sommes.** 12/10/2026. Le user envoie une vidéo dans un groupe
> chiffré et voit une bulle qui tourne, sans pourcentage : « ça tourne, ça
> stresse la personne qui envoie ». Le pourcentage existait (chapitre 44) —
> mais seulement pour le **téléversement**. Ce chapitre comble le trou
> d'avant : la **préparation**.
>
> Mobile : `chiffrerVersFichierHorsDuFil(onProgression:)`,
> `EnvoiChiffreEnCours(preparation:)`.

---

## 1. Où passait le temps

Avant le premier octet envoyé, le téléphone :

1. fabrique l'aperçu (la première image d'une vidéo) ;
2. **chiffre tout le fichier**, bloc de 64 Kio par bloc de 64 Kio
   (chapitre 43) — en Dart pur, c'est l'étape longue ;
3. réserve l'envoi, prépare le message.

La bulle n'affichait un chiffre qu'à partir de l'étape suivante. Pendant le
chiffrement d'une vidéo, elle tournait **sans rien dire** — exactement ce qui
inquiète.

## 2. Un isolat qui parle

Le chiffrement tourne dans un isolat pour ne pas figer l'écran. Or
`Isolate.run` ne dit **rien** avant d'avoir fini : il rend un résultat, pas
une progression.

On passe donc à `Isolate.spawn` avec un **port** :

```
isolat principal                         isolat de chiffrement
────────────────                         ─────────────────────
ReceivePort ◀──── 0.01, 0.02, … ──────── après chaque bloc, au changement de %
            ◀──── FichierChiffreSurDisque  à la fin
            ◀──── « message d'erreur »     en cas d'échec
```

- l'avancement est envoyé **au changement de pour cent** seulement : un
  message par bloc de 64 Kio en ferait des milliers pour une vidéo ;
- le point d'entrée de l'isolat est une fonction **de premier niveau** : son
  seul contexte est son message (la leçon du chapitre 27, « object is
  unsendable ») ;
- sans `onProgression`, on garde `Isolate.run` : rien ne change pour les
  appelants qui n'en ont pas besoin.

## 3. Deux étapes, deux mots

La bulle affiche désormais :

| Étape | Ce qu'on voit |
|---|---|
| aperçu (un instant) | l'anneau qui tourne, « Préparation » dessous |
| chiffrement | « **42 %** », « Préparation » dessous |
| téléversement | « **18 %** », « Envoi… » dessous |
| octets partis | « Envoi… » (le serveur assemble et publie) |

Le pourcentage repart de zéro entre les deux étapes : c'est voulu, et le mot
écrit dessous dit pourquoi. Un seul pourcentage fusionné aurait dû deviner
combien pèse chaque étape — le chiffrement dépend du téléphone, l'envoi du
réseau.

## 4. Deux défauts traités le même jour

- **L'ouverture de l'application** restait sur une roue tant que le serveur
  n'avait pas répondu à `/api/me` — jusqu'à 30 s sur un réseau lent —, alors
  que le profil était en cache. Avec un profil et une session enregistrés,
  l'accueil s'ouvre immédiatement ; la vérification continue en arrière-plan,
  et une session condamnée renvoie toujours à l'écran de connexion. Et
  `main` attendait le jeton Firebase (un appel réseau) avant le premier
  affichage : il est désormais demandé sans être attendu.
- **La prévisualisation de la galerie** ne montrait qu'une **vignette** de la
  vidéo, avec un symbole de lecture décoratif. La vidéo de la page affichée
  se lit désormais — un seul lecteur à la fois, libéré quand on tourne la
  page.

## 5. Les preuves

`test/e2ee_media_fichier_test.dart` — 13 ✓, dont : la progression est
**croissante**, atteint **100 %**, passe par des étapes intermédiaires, et le
fichier chiffré est **identique** (relu par `dechiffrerFichier`) ; une source
introuvable lève sans laisser de fichier à moitié écrit. Suite mobile :
449 ✓. À juger sur téléphone : le temps de préparation d'une vidéo de
100 Mo.
