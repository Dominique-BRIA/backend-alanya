# Chapitre 44 — Le téléphone envoie en morceaux

> **Où nous en sommes.** 10/10/2026. Le serveur reçoit des morceaux et publie
> le message à la place de l'appareil (chapitre 42) ; le téléphone sait
> chiffrer de fichier à fichier (chapitre 43). Ce chapitre assemble les deux
> côté téléphone : préparer au premier plan, puis confier les octets à
> Android, qui continue application fermée.
>
> Mobile : `lib/features/chat/envoi_morceaux/`. Banc de bout en bout :
> `STAGE-WEB/scripts/e2ee-media-morceaux-mobile.mjs` +
> `alanya/test/interop_media_morceaux_reel_test.dart`.

---

## 1. La frontière : ce qui doit se faire au premier plan

Toute la difficulté tient en une phrase : **le chiffrement doit être fini
avant que l'application puisse mourir.**

```
PREMIER PLAN (l'utilisateur regarde l'écran)        ARRIÈRE-PLAN (Android)
─────────────────────────────────────────────        ──────────────────────
1. aperçu                                             7. morceaux poussés,
2. chiffrement de fichier à fichier (ch. 43)             réessayés, même
3. réservation → id de l'envoi = id du média             application fermée
4. descripteur (cite le média par cet id)
5. préparation : id du message, enveloppes            SERVEUR
   ou chiffré de groupe  ← le cliquet avance ICI      8. dernier morceau :
   programmation chez le serveur                         assemble et PUBLIE
6. ma copie : cache, archive, clair
```

Après l'étape 5, il ne reste que des **octets opaques**. Android n'a besoin
d'aucun code Dart pour les pousser, et le serveur n'a besoin de personne pour
publier.

> **Pourquoi pas chiffrer en tâche de fond ?** La session Signal est un
> cliquet : chaque message la fait avancer. Une tâche de fond et
> l'application qui chiffrent sur la même session au même moment la
> désynchronisent, et les messages suivants deviennent illisibles. On ne
> partage pas un cliquet entre deux exemplaires du code.

## 2. Préparer sans envoyer

Deux fonctions savaient chiffrer **et** envoyer d'un même geste :
`E2eeFil.envoyerMedia` (tête-à-tête) et `GroupeChiffre.envoyer` (groupe).
On a séparé les deux temps :

- **Groupe** : `preparer` rend l'identifiant tiré et le chiffré signé ;
  `envoyer` l'appelle, puis poste. Une seule fabrication pour les deux
  chemins.
- **Tête-à-tête** : `preparerMedia` tire l'identifiant **lui-même**, comme
  en groupe depuis le chapitre 32. Avant, on l'obtenait du serveur en créant
  la ligne ; mais la charge v2 le scelle, et la ligne n'existera qu'à la fin
  de l'envoi. Il faut donc le connaître d'avance.

## 3. Le choix du transport : tout confier d'un coup

Trois façons de laisser Android envoyer, une seule tient :

| | Verdict |
|---|---|
| Garder la requête dans le code Dart, sous un service de premier plan | ❌ Balayer l'application détruit le moteur Dart, donc la requête |
| Une file qui confie le morceau suivant quand le précédent finit, en « tâches lancées par l'utilisateur » (Android 14+) | ❌ Android refuse de programmer ces tâches hors du premier plan — c'est-à-dire exactement application fermée |
| **Tous les morceaux confiés d'un coup à WorkManager, au premier plan** | ✅ Rangés sur disque, ils survivent à la fermeture et au redémarrage du téléphone |

WorkManager les envoie quelques-uns à la fois (son propre parallélisme, 3 à 4
selon le téléphone), attend le réseau, réessaie chacun jusqu'à dix fois. Un
morceau fait 1 Mio : bien en dessous des neuf minutes accordées à une tâche
de fond, même en 3G.

Chaque tâche envoie une **tranche** du même fichier : l'en-tête `Range`
(borne de fin **incluse**) est lu par la bibliothèque et n'est pas transmis
au serveur. Inutile de découper le fichier en petits fichiers sur le disque.

## 4. Le pourcentage

L'utilisateur voulait voir « 10, 15, 18, 20 % ». Deux règles :

- **pondéré par les octets**, pas par les morceaux : le dernier morceau est
  souvent plus court ;
- **jamais 100 % avant la réponse du serveur** : tous les octets peuvent
  être partis alors que l'assemblage et la publication restent à faire. On
  plafonne à 99 %, et la bulle affiche l'entier **inférieur** (`floor`) —
  l'ancien `round` pouvait afficher 100.

Application ouverte, la bulle suit aussi l'avancement **à l'intérieur** de
chaque morceau. Application fermée, la notification Android (une seule pour
tout le fichier, pas une par morceau) le prend en charge.

## 5. Reprendre, et nettoyer

Un fichier `envoi.json` à côté du chiffré garde ce qu'il faut pour retrouver
l'envoi après la mort de l'application — **le jeton d'envoi compris**. Au
démarrage, chaque envoi est relu **chez le serveur**, qui seul sait la vérité :

- terminé → on efface le chiffré local ;
- en cours → on redonne à Android les morceaux qu'il n'a plus ;
- inconnu ou expiré → on efface.

C'est aussi le nettoyage : application fermée, personne n'a vu le dernier
morceau partir.

## 6. Les erreurs rencontrées, et leurs solutions

### a) `markDownloadedComplete`, un piège pour les envois

`FileDownloader().start()` marque par défaut « terminée » toute tâche dont
le fichier existe. C'est pensé pour les **téléchargements**. Pour un
**envoi**, le fichier source existe toujours : chaque morceau en attente
aurait été déclaré parti. **Parade** : `start(markDownloadedComplete: false)`.

### b) Un écran qui attendait le premier fichier pour préparer le second

L'écran envoyait plusieurs fichiers en attendant la fin **complète** de
chacun. Avec les morceaux, on n'attend plus que la **préparation**, qui doit
rester séquentielle pour l'ordre du cliquet ; l'envoi des octets se suit à
côté.

### c) Une publication refusée n'est pas un fichier perdu

Clé de groupe changée pendant l'envoi : le serveur refuse de publier
(`refus:VERSION_PERIMEE`) mais le fichier est arrivé. L'écran renvoie alors
le message par le chemin ordinaire, avec le **même** média : rien à
retéléverser.

### d) Le banc qui ne se connectait plus

« Un compte, un téléphone » : le compte de banc d'Alice était lié à
l'appareil `banc-media-mobile-alice`. En le renommant, la connexion était
refusée (`TELEPHONE_DEJA_ASSOCIE`). On garde le même nom.

### e) « Espace disque insuffisant »

La garde de réservation (taille + 1 Gio de marge) a refusé l'envoi en local :
le disque C: du poste n'avait plus que **574 Mo libres**. Ce n'était pas un
défaut — la garde a fait exactement son travail. Le banc a été relancé avec
`ENVOIS_MORCEAUX_DIR` sur un autre disque.

## 7. Les preuves

| Banc | Résultat |
|---|---|
| `e2ee-media-morceaux-mobile.mjs` — le vrai code mobile chiffre, réserve, programme, pousse 3 morceaux ; le serveur publie ; Bob, dans Chrome, voit la photo déchiffrée à 40 px avec sa légende | **TOUT EST VERT** (13 ✓), pourcentages vus : 20, 60, 99, 100 |
| `test/envoi_morceaux_test.dart` — découpage, `Range`, pourcentage pondéré, jamais 100 % avant le serveur, identifiants de tâche, réponses du serveur | 16 ✓ |
| Suite mobile complète | 447 ✓ |

## 8. Ce qui reste vrai

- **Le transport Android n'a été validé que par la compilation de la CI.**
  Le banc pousse les morceaux en HTTP direct ; le comportement réel
  (application fermée, balayée, téléphone redémarré) se juge **sur un
  téléphone**.
- Quitter la conversation cache la bulle d'avancement ; la notification
  continue, et le message apparaît à sa publication.
- Fils **chiffrés** seulement ; le chemin en clair (statuts, photos de
  profil) viendra au lot 4, le web au lot 5.
