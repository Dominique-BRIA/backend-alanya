# Chapitre 43 — Chiffrer de fichier à fichier

> **Où nous en sommes.** 10/10/2026. Le serveur sait recevoir un fichier en
> morceaux et publier le message à la place de l'appareil (chapitre 42). Côté
> téléphone, il faut d'abord un fichier **chiffré sur le disque** : c'est lui
> qu'Android enverra par tranches, application fermée. Ce chapitre est court,
> parce que le format nous a fait un cadeau.
>
> Mobile : `lib/services/e2ee/e2ee_media_fichier.dart`,
> `test/e2ee_media_fichier_test.dart`.

---

## 1. Le problème : tout en mémoire

`chiffrerFichier` (chapitre 23) reçoit le fichier entier en `Uint8List` et
rend le chiffré entier en `Uint8List`. Pour une vidéo de 250 Mo :

| | Mémoire |
|---|---|
| le clair, lu par le sélecteur | 250 Mo |
| le chiffré | 250 Mo |
| la requête multipart qui le recopie | 250 Mo |

Trois quarts de gigaoctet : Android tue l'application, et l'envoi avec elle.
Et surtout, ce chiffré **disparaît avec la mémoire** : impossible de le
confier à une tâche de fond qui survivrait à la fermeture.

## 2. Le cadeau du format AGB1

Rappel du format : le fichier est découpé en blocs de **64 Kio**, chacun
chiffré **séparément** en AES-256-GCM, avec un nonce **calculé** :

```
nonce (12 octets) = 7 octets nuls | index du bloc (4 octets, gros-boutiste) | 1 octet : 1 si dernier bloc, sinon 0
```

Rien n'est tiré au hasard dans le nonce, et chaque bloc ne dépend que de
lui-même. Conséquence : chiffrer **bloc par bloc**, en lisant 64 Kio du disque
et en écrivant 64 Kio + 16 octets d'étiquette, produit **exactement les mêmes
octets** que tout chiffrer d'un coup — à clé égale.

C'est ce qui permet de changer **la manière** de chiffrer sans toucher **au
format** : le web, les anciennes applications, l'archive — personne n'a rien
à changer.

> **À retenir.** Quand on conçoit un format de fichier chiffré, découper en
> blocs indépendants à nonce déterministe n'est pas un détail : c'est ce qui
> rend possibles, plus tard, le flux, la reprise et le parallélisme.

## 3. L'empreinte, au fil de l'eau

Le descripteur porte le SHA-256 du **chiffré**. Relire le fichier écrit pour
le calculer doublerait les lectures. On nourrit donc le condensat **bloc par
bloc**, au moment où l'on écrit (`SHA256Digest.update`), et on le termine à
la fin (`doFinal`).

Le serveur, lui, vérifie l'assemblage avec la même empreinte, mais en
**hexadécimal** ; le descripteur la porte en **base64**. Le résultat expose
les deux (`empreinteHex`, `empreinteBase64`) : deux écritures, une seule
valeur.

## 4. Les pièges, et leurs parades

### a) Une lecture peut rendre moins que demandé

`readIntoSync(tampon, 0, n)` peut rendre **moins** de `n` octets sans que le
fichier soit fini. Prendre ce qui vient comme « le bloc » produirait un bloc
court au milieu du fichier — donc un nonce attribué au mauvais contenu, et un
fichier indéchiffrable. **Parade** : on insiste jusqu'au bloc entier, et un
`0` avant la fin (fichier raccourci pendant la lecture) est une **erreur**,
pas un fichier plus petit.

### b) Un chiffré à moitié écrit

Si la lecture échoue au milieu, un fichier tronqué reste sur le disque. Envoyé,
il serait refusé à l'ouverture par l'étiquette GCM du bloc coupé — mais il ne
doit même pas partir. **Parade** : en cas d'échec, le `finally` **efface** la
destination.

### c) L'isolat qui emporte tout

Chiffrer 250 Mo prend du temps : il faut un isolat. Mais un `Isolate.run`
écrit sur place emporte tout le contexte de la fonction qui l'a créé
(chapitre 27, « object is unsendable »). **Parade** : la même que pour
`chiffrerHorsDuFil` — une fonction de premier niveau
(`chiffrerVersFichierHorsDuFil`) dont le seul contexte est celui de ses
paramètres.

### d) Le fichier vide

Un fichier de 0 octet fait **un** bloc vide (seize octets d'étiquette), et non
zéro bloc : c'est la règle de `chiffrerFichier`, et la reproduire est la seule
façon de garantir l'égalité.

## 5. Les preuves

`flutter test test/e2ee_media_fichier_test.dart` — **11 ✓** :

- sept tailles choisies sur les **bords** du découpage (vide, 1 octet,
  64 Kio − 1, 64 Kio pile, 64 Kio + 1, trois blocs et un reste, 1,2 Mo) :
  depuis un fichier **et** depuis des octets, mêmes octets, même empreinte,
  même clé que `chiffrerFichier`, et `dechiffrerFichier` rend le clair ;
- l'empreinte hexadécimale vaut bien la base64 ;
- sans clé imposée, une clé **neuve** à chaque fichier ;
- source introuvable : aucun fichier à moitié écrit ne reste ;
- le chemin réel, dans un isolat.

## 6. Ce qui reste vrai

- **Le coût du chiffrement n'a pas baissé** : `pointycastle` est du Dart pur.
  En mode test, 1,2 Mo chiffré deux fois et relu prend plusieurs secondes ;
  un APK compilé est bien plus rapide, mais il faudra **mesurer sur
  téléphone** une vidéo de 100 Mo. Si c'est trop lent, le format permet de
  commencer à envoyer les premiers morceaux pendant qu'on chiffre les
  suivants.
- Le **sélecteur de fichiers** fournit encore souvent les octets en mémoire
  (`MediaPickResult.bytes`). Le chemin (`path`) doit être préféré quand il
  existe : c'est au lot 3 de le brancher.
