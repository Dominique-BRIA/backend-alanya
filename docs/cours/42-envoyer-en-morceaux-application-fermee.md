# Chapitre 42 — Envoyer en morceaux, même application fermée

> **Où nous en sommes.** 10/10/2026. Demande du user : « envoyer les fichiers
> en morceaux pour améliorer la rapidité, même quand l'application est fermée
> ou en arrière-plan ». Ce chapitre couvre la partie **serveur** : recevoir un
> fichier par morceaux, puis **publier le message chiffré à la place de
> l'appareil**, quand celui-ci n'est plus là pour le faire. Le téléphone
> (chiffrer vers un fichier, confier les morceaux à Android, afficher le
> pourcentage) fera le chapitre suivant.
>
> Backend : lot 1 `4c86695`, lot 1b (ce chapitre). Rien n'est déployé.

---

## 1. Le diagnostic : pourquoi l'envoi était lent et fragile

Avant ce travail, un fichier partait **d'un seul bloc** :

```
téléphone ──(tout le fichier)──▶ nginx ──▶ Next (tout en mémoire) ──▶ R2
```

Trois défauts, par ordre de gravité :

1. **Aucune reprise.** Une coupure à 90 % obligeait à tout renvoyer. Sur un
   réseau mobile instable, une grosse vidéo pouvait ne jamais arriver.
2. **Le chemin chiffré n'avait aucune protection** : ni notification, ni
   service Android, ni sauvegarde sur disque. C'est pourtant le chemin de
   toutes les conversations chiffrées.
3. **« Application fermée » était impossible par construction** : la
   requête vivait dans le code Dart, que la fermeture de l'application
   arrête. Et même si le fichier arrivait, **personne ne postait le
   message** — c'est le téléphone qui le fait, après le téléversement.

Le troisième point est le plus instructif : on ne règle pas « l'application
fermée » en rendant le transfert plus robuste. Il faut que **plus rien ne
dépende de l'application après le dernier octet**.

## 2. Le choix d'architecture : par le VPS, en morceaux de 1 Mio

Deux options étaient sur la table : envoyer directement chez Cloudflare R2
(URL signées), ou passer par notre serveur. Le user a choisi **le VPS**.

| | Direct vers R2 | Par le VPS (retenu) |
|---|---|---|
| Taille minimale d'un morceau | 5 Mio (règle S3) | libre : **1 Mio** |
| Perte sur coupure | jusqu'à 5 Mio | **au plus 1 Mio** |
| Bande passante du VPS | épargnée | sollicitée |

Le fichier se reconstitue sur le disque du VPS. Chaque morceau est **numéroté**
et **s'écrit à sa place** (`position = n × taille`) : l'ordre d'arrivée ne
compte pas, plusieurs morceaux voyagent en même temps, et un morceau perdu se
renvoie seul.

## 3. Le parcours, côté serveur

```
POST /api/media/envois                      → { id, mediaId, jeton, tailleMorceau, nbMorceaux }
PUT  /api/media/envois/:id/morceaux/:n      → (X-Envoi-Jeton) un morceau, corps brut
POST /api/media/envois/:id/publication      → (jeton d'accès) le message préparé
GET  /api/media/envois/:id                  → morceaux manquants, média, publication
POST /api/media/envois/:id/terminer         → filet : relance assemblage / publication
DELETE /api/media/envois/:id                → abandon
```

Le **dernier morceau** fait tout : il assemble le fichier en média ordinaire,
puis publie le message s'il y en a un de programmé. Android n'a que des
morceaux à pousser — aucune étape finale qui demanderait le code Dart.

## 4. La publication différée : le cœur du chapitre

### Le principe

L'appareil prépare **tout** au premier plan, pendant que l'utilisateur
regarde encore l'écran :

1. il tire l'**identifiant du message** (UUID v4) ;
2. il écrit le **descripteur chiffré** du fichier, qui cite le média par son
   identifiant — et cet identifiant est **celui de l'envoi**, connu dès la
   réservation ;
3. il chiffre les **enveloppes Signal** (tête-à-tête) ou le **chiffré du
   groupe** ;
4. il confie ce paquet au serveur (`…/publication`).

Le serveur ne peut rien en lire. Quand le dernier morceau arrive, il fait
exactement ce que l'appareil aurait fait : `creerMessage`, dépôt des
enveloppes, sonnette, notification.

### Pourquoi le chiffrement reste au premier plan

On aurait pu réveiller le code Dart en tâche de fond pour chiffrer à la fin.
C'est **dangereux** : la session Signal est un **cliquet** — chaque message
la fait avancer. Deux exemplaires du code (l'application et une tâche de fond)
qui chiffrent en même temps sur la même session peuvent la désynchroniser,
et les messages suivants deviennent illisibles. Ici, **rien de
cryptographique ne se passe après la préparation** : le serveur ne fait que
poser des octets opaques.

### Ce qui a dû changer dans le protocole

Dans un fil chiffré à deux, l'identifiant du message est **scellé dans
l'enveloppe** (protocole v2) : le destinataire vérifie que l'enveloppe
appartient bien à ce message. Jusqu'ici, le serveur créait la ligne et
l'appareil chiffrait **ensuite** avec l'identifiant obtenu. Pour préparer les
enveloppes avant la fin du fichier, il faut connaître l'identifiant
**d'avance** — exactement comme en groupe depuis le chapitre 32.

`creerMessage` accepte donc un identifiant tiré par l'appareil **aussi dans
un fil chiffré à deux**, mais seulement par ce chemin : la route REST ne
transmet un `id` qu'avec une charge de groupe. Rien ne change pour elle.

## 5. Les erreurs rencontrées, et leurs solutions

### a) Le jeton d'accès expire pendant l'envoi

Le jeton d'accès dure **15 minutes**. Une vidéo en 3G, application fermée,
peut prendre plus longtemps, et l'application n'est plus là pour le
renouveler. **Solution** : un **jeton d'envoi**, rendu à la réservation, qui
n'ouvre **que cet envoi** et dure autant que lui. En base, seule son
empreinte SHA-256 est gardée.

### b) Deux morceaux finissent en même temps

Avec trois morceaux en vol, les deux derniers peuvent compter « tout est là »
à la même milliseconde, et assembler **deux fois** (deux médias, deux
messages). **Solution** : le passage `en_cours → assemblage` est une
**écriture conditionnelle** (`updateMany … where statut = 'en_cours'`) : la
base n'en laisse passer qu'une. Même garde pour `attente → en_cours` de la
publication. Prouvé : six morceaux envoyés d'un coup → **un seul média**.

### c) Un morceau coupé en route ne doit pas compter

Une connexion qui tombe livre un corps **plus court**. S'il était marqué
« reçu », le fichier assemblé serait faux. **Solution** : la taille attendue
de chaque morceau est **exacte** (`tailleDuMorceau`), et le morceau n'est
marqué qu'après l'avoir atteinte. Prouvé en coupant net une connexion au
milieu d'un morceau (le scénario de l'ascenseur).

### d) Un refus de publication ne doit pas faire renvoyer le morceau

Entre la programmation et la fin du fichier, des heures peuvent passer : un
blocage, une clé de groupe changée. Si le dernier morceau répondait par une
erreur, Android le **renverrait en boucle**. **Solution** : le morceau est
toujours accepté ; le refus est **noté** (`refus:BLOQUE`,
`refus:VERSION_PERIMEE`), le média reste, et l'appareil renverra le message
par le chemin ordinaire à sa prochaine ouverture.

### e) Le build traçait tout le projet

`path.join(process.cwd(), dossier)` a fait croire à Turbopack qu'on lisait
n'importe quel fichier : avertissement « Encountered unexpected file in NFT
list ». **Solution** : `path.join(/*turbopackIgnore: true*/ process.cwd(), …)`.

### f) Mes propres erreurs de banc

Deux contrôles ont échoué au premier passage, et **aucun n'était un défaut du
code** — mais il fallait le prouver, pas le supposer :

- J'attendais un champ `publication` dans la réponse d'un morceau
  intermédiaire ; il n'y en a que dans la réponse finale et dans l'état.
- Le message de groupe tombait sur une **clé étrangère** : un groupe chiffré
  doit avoir sa ligne `e2ee_cle_versions`, que mon banc ne créait pas. Le
  code, lui, a eu le bon réflexe : erreur **avant** la ligne du message, donc
  retour en « attente », réessayable.

Et un troisième constat, hors de ce travail : `scripts/e2ee-banc.mjs` est
**cassé depuis le 28/09** (sa dernière retouche est antérieure de quelques
heures à la garde « fil non chiffré » du commit `fdc8fce`). Il dépose dans un
fil qu'il n'a pas chiffré.

## 6. Les preuves

| Banc | Résultat |
|---|---|
| `scripts/envoi-morceaux-banc.mjs` — désordre, doublons, coupure net, accès, concurrence, empreinte fausse, chiffré, abandon, expiration, non-régression de `POST /api/media` | 42 ✓ |
| `scripts/publication-differee-banc.mjs` — refus à la programmation, tête-à-tête publié avec son identifiant et ses enveloppes (relevées par le destinataire), programmation après la fin, blocage survenu entre-temps, groupe, clé changée, reprise après arrêt | 37 ✓ |
| `scripts/e2ee-depot-banc.mjs` (le dépôt d'enveloppes a été extrait en module) | TOUT EST VERT |
| `scripts/groupe-chiffre-banc.mjs` (`creerMessage` a changé) | Tous les contrôles passent |
| `node src/lib/envoi-morceaux.mjs` (calculs de découpage) | 30 ✓ |

## 7. Ce qui reste vrai

- **Fils chiffrés seulement.** Un message en clair créé par REST ne prévient
  personne en temps réel : la publication différée en clair attendra.
- **Le fichier passe en mémoire à l'assemblage** (250 Mo au plus, comme
  avant), pour réutiliser le chemin de rangement vers R2 déjà éprouvé.
- **Rien n'est fait côté téléphone** : c'est le chapitre suivant.
