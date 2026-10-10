# Chapitre 45 — Les envois en clair aussi

> **Où nous en sommes.** 10/10/2026. Les médias des fils chiffrés partent en
> morceaux, application fermée (chapitres 42 à 44). Restaient les fils **en
> clair** : sur les sept derniers jours en production, 16 médias (56 Mo)
> contre 83 dans des fils chiffrés. Ce chapitre est court : le moteur existe,
> on lui ouvre une seconde porte.
>
> Mobile : `SuiviEnvoisMorceaux.lancerFichier` / `suivre`,
> `EnvoiMediaStore._envoyerEnMorceaux`. Banc :
> `test/interop_fichier_morceaux_reel_test.dart`.

---

## 1. Ce qui change, et ce qui ne change pas

| | Fil chiffré (ch. 44) | Fil en clair (ce chapitre) |
|---|---|---|
| Les octets | morceaux, Android, app fermée | **pareil** |
| Le fichier sur le serveur | nom et type neutres | **vrai nom, vrai type** |
| Le message | publié **par le serveur** au dernier morceau | posté **par l'application** une fois le fichier arrivé |

Pourquoi pas la publication différée en clair ? Le serveur sait annoncer un
message **chiffré** en temps réel (la sonnette `e2ee_arrivee`), mais pas un
message en clair qu'il créerait lui-même : son pont vers le WebSocket
n'accepte que les trames `e2ee_*`. Publier en clair depuis le serveur ferait
arriver le message **sans bruit**. On garde donc la file d'envoi actuelle
pour le message : application fermée, le fichier part quand même, et le
message suit à la réouverture.

## 2. Pas de copie de plus

La file d'envoi range déjà ses fichiers sous les **documents** de
l'application (`envois_en_attente/<envoi>/<rang>_<nom>`), pour survivre à la
mort de l'application. Android envoie **directement de là** : la tâche
désigne ce fichier et l'en-tête `Range` sa tranche. Aucune copie
supplémentaire.

## 3. Reprendre au lieu de recommencer

Avant, un envoi interrompu repartait de zéro au retour du réseau. Désormais,
la **réservation** de chaque fichier est gardée avec l'envoi, sur le disque.
Au redémarrage, `suivre(réservation)` relit l'envoi **chez le serveur** :

- terminé → l'identifiant du média est connu, le message peut partir ;
- en cours → Android ne reçoit que les morceaux **manquants**.

Sans cela, chaque redémarrage aurait ouvert une nouvelle réservation, et
l'ancienne serait restée sept jours sur le serveur pour rien.

## 4. Une seule notification

La file d'envoi affichait sa propre notification de progression. Elle
resterait **figée** dès que l'application meurt, alors qu'Android continue.
Pour ces envois, on retire la nôtre : seule celle d'Android, qui survit,
reste affichée.

## 5. Abandonner pour de bon

« Supprimer » un envoi en attente annule désormais aussi les morceaux confiés
à Android, et demande au serveur d'effacer le fichier partiel. Sans cela,
Android aurait fini d'envoyer un fichier dont plus personne ne voulait.

## 6. Les preuves, et une erreur de test

`test/interop_fichier_morceaux_reel_test.dart`, contre le vrai serveur : un
premier transport ne pousse qu'**un** morceau puis « meurt » ; un second
reprend par la réservation. Le serveur rend le fichier **entier, octet pour
octet**, sous `video/mp4`. ✓

> **L'erreur.** La première version du test remplissait le fichier avec
> `Random(7).nextInt(256)` **recréé à chaque octet** : le fichier n'était fait
> que d'un seul octet répété. Le test passait — mais il aurait aussi passé si
> un morceau avait été écrit au mauvais endroit, puisque tous les morceaux
> étaient identiques. Un contenu de test doit pouvoir **révéler** l'erreur
> qu'on cherche : un seul générateur, tiré une fois.

Le banc chiffré du chapitre 44 a été rejoué après la généralisation du
moteur : toujours **TOUT EST VERT**. Suite mobile : 447 ✓.

## 7. Ce qui reste vrai

- Application fermée, le **message en clair** attend la réouverture (le
  fichier, lui, est déjà arrivé).
- Les **statuts** et les photos de profil gardent l'envoi d'un seul bloc :
  petits fichiers, pas de conversation à prévenir.
- À juger sur téléphone, comme le chapitre 44.
