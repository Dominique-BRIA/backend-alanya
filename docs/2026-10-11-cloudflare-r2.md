# Cloudflare R2 dans Alanya Work

*Ce qui a été fait, comment ça marche, et ce qu'il reste à faire — 11/10/2026*

## En bref

Les fichiers d'Alanya Work ont quitté Backblaze pour **Cloudflare R2**, en deux jours :

| Date | Seau Cloudflare | Contenu | Volume |
|---|---|---|---|
| 10/10 | `alanyawork` (privé) | fichiers des discussions, messages laissés sur le répondeur | 764 fichiers, 589 Mo |
| 11/10 | `profilemedia` (public) | accueils de répondeur, sonneries | 22 fichiers, 14,3 Mo |
| 11/10 | `alanyaprofile` (public) | photos de profil des comptes et des groupes | 14 photos |

Les trois seaux portent **les mêmes noms que chez Backblaze**, et ils restent séparés : on n'a rien fusionné. Ils sont tous rangés en Europe de l'Ouest (WEUR).

Pour les utilisateurs, rien n'a changé : mêmes écrans, mêmes adresses de fichiers dans la base. Seul l'endroit d'où partent les octets a changé.

## La méthode : une seule langue, l'API « S3 »

S3 est le service de stockage d'Amazon. Son interface est devenue un standard, que Backblaze et Cloudflare parlent tous les deux. Le serveur utilise la bibliothèque officielle d'Amazon (`@aws-sdk/client-s3`). Pour changer d'hébergeur, il a suffi de changer quatre choses :

- **l'adresse** du service (`<compte>.r2.cloudflarestorage.com`) ;
- **la région**, qui vaut toujours `auto` chez Cloudflare ;
- **le nom du seau** ;
- **la clé d'accès**.

Deux différences de comportement ont demandé du code :

1. **Les sommes de contrôle.** La bibliothèque d'Amazon ajoute d'office des sommes de contrôle à chaque envoi, et Cloudflare en refuse certaines. On les limite donc au strict nécessaire (réglage `WHEN_REQUIRED`).
2. **Les versions.** Backblaze garde les anciennes versions d'un fichier ; Cloudflare non. Effacer une photo « vue unique » demande donc une seule suppression chez Cloudflare, alors qu'il fallait effacer toutes les versions chez Backblaze.

## Comment chaque seau sert ses fichiers

**Le seau privé (`alanyawork`).** Personne ne peut lire un fichier sans passer par le serveur. Quand l'application demande un fichier, le serveur vérifie que l'utilisateur y a droit. Il fabrique ensuite une **adresse signée, valable une heure**, et le téléphone ou le navigateur télécharge directement chez Cloudflare. Le serveur décide, mais ne transporte pas les fichiers.

**Les accueils et sonneries (`profilemedia`).** Ces sons sont de toute façon entendus par tous les appelants. Ils ont donc une **adresse publique fixe**, gardée en cache un an. Un accueil déjà entendu ne se retélécharge pas, et il démarre dès que la sonnerie s'arrête. Si le navigateur ne peut pas lire l'adresse directe, le web la redemande au serveur : le son arrive quand même, un peu plus lentement. Règle absolue : **un message laissé PAR quelqu'un ne va jamais dans ce seau**, il reste dans le seau privé.

**Les photos de profil (`alanyaprofile`).** Ce seau, créé le 26/09, n'avait jamais servi. Il contient maintenant ce pour quoi il a été créé.

- **Même adresse qu'avant.** La base garde l'adresse habituelle (`https://alanyavox.com/api/avatars/<id>`), parce qu'elle est partagée avec la plateforme de l'équipe, qui la lit directement. Mettre une adresse Cloudflare en base l'aurait cassée, et il aurait fallu migrer toutes les adresses à chaque changement d'hébergeur.
- **Cloudflare envoie la photo.** Quand une photo est dans le seau, cette adresse **renvoie vers Cloudflare** (redirection) : c'est Cloudflare qui envoie l'image, plus le serveur.
- **Quand une photo entre dans le seau.** Au moment où on la choisit (profil ou groupe). Les photos plus anciennes y entrent à leur premier affichage, ce qui couvre aussi celles écrites par la plateforme de l'équipe.
- **Quand une photo sort du seau.** Dès que plus personne ne l'a pour photo. Sinon, une ancienne photo resterait visible sur Internet.
- **Ce qui n'entre jamais.** Seulement une image, en clair, que son propriétaire a mise en photo. Une image reçue en discussion ne peut pas être rendue publique en la collant comme photo de profil.
- **Retour en arrière.** L'original reste toujours dans le seau privé.

## Les interrupteurs, et le retour en arrière

Chaque seau a son interrupteur dans le fichier `.env` du serveur (`~/backend-alanya/.env`) :

| Interrupteur | Seau | Variables qui l'accompagnent |
|---|---|---|
| `STOCKAGE_PRIVE=r2` | `alanyawork` | `R2_ENDPOINT`, `R2_BUCKET`, `R2_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| `STOCKAGE_PUBLIC=r2` | `profilemedia` | `R2_PUBLIC_BUCKET`, `R2_PUBLIC_URL`, `R2_PUBLIC_KEY_ID`, `R2_PUBLIC_SECRET_ACCESS_KEY` |
| `STOCKAGE_PROFIL=r2` | `alanyaprofile` | `R2_PROFIL_BUCKET`, `R2_PROFIL_URL`, `R2_PROFIL_KEY_ID`, `R2_PROFIL_SECRET_ACCESS_KEY` |

- **Variable manquante.** Si une variable manque, le serveur **ne bascule pas** : il reste comme avant, l'écrit une fois dans son journal, et le point de santé le signale. Une configuration à moitié remplie ne peut donc pas casser le service.
- **Revenir en arrière.** Retirer la ligne de l'interrupteur, puis `pm2 restart alanya-api alanya-ws --update-env`. Pour le seau privé seulement, il faut aussi recopier vers Backblaze les fichiers envoyés depuis la bascule : `node --env-file=.env scripts/copier-vers-r2.mjs --inverse`.
- **Copies de l'ancien `.env`** : `~/env-avant-r2.bak` (avant le seau privé) et `~/env-avant-r2-public.bak` (avant les deux seaux publics).

## Sécurité

- **Une clé par seau.** Chacune est limitée à son seau, avec les droits « lire et écrire ». Si l'une fuitait, elle ne donnerait accès à aucun autre seau.
- **Les clés ne vivent que dans le `.env` du serveur**, jamais dans un dépôt ni dans un message.
- **CORS** : seul `https://alanyavox.com` peut lire les fichiers depuis une page web. Cette règle est posée sur chaque seau, dans Cloudflare.
- **Politique de sécurité du web** (`vite.config.ts`, liste `SEAUX_MEDIAS`). Elle autorise chaque seau **par son adresse exacte**, jamais `*.r2.dev`, que n'importe qui peut ouvrir. ⚠️ Une adresse oubliée dans cette liste casse les images **sur le web seulement** (le mobile n'a pas cette liste), sans aucune erreur côté serveur.

## Les outils de contrôle

- **Le point de santé** : `https://alanyavox.com/api/health`, rubrique `stockage`. Il dit qui sert quoi (`fournisseur`), si chaque seau répond (`actif`), et pourquoi s'il ne répond pas (`raison`). Aucun secret n'y figure.
- **`scripts/copier-vers-r2.mjs`** copie un seau de Backblaze vers Cloudflare :
  - `--essai` compte les fichiers sans rien copier ;
  - sans option, il copie ce qui manque ;
  - `--verifier` compare les deux seaux ;
  - `--inverse` fait le retour en arrière ;
  - ajouter `--public` pour traiter les accueils et sonneries.

  On peut le relancer sans risque : il saute ce qui est déjà copié et ne supprime jamais rien. Pour le seau public, `--verifier` essaie en plus l'adresse publique comme le ferait un téléphone (réponse, cache, CORS).
- **`scripts/avatars-profil.mjs`** gère les photos de profil :
  - `--etat` donne les nombres ;
  - `--publier` copie toutes les photos en cours ;
  - `--verifier` suit une photo jusqu'à Cloudflare ;
  - `--nettoyer` retire du seau les photos que plus personne n'a.

## Ce qui reste chez Backblaze, et pourquoi

- **Les sauvegardes de la base**, dans `sauvegardes/` du seau `alanyawork`. **C'est voulu** : garder les sauvegardes chez un autre fournisseur que les fichiers protège contre une panne ou un compte bloqué chez l'un des deux.
- **Les anciennes copies des fichiers**, conservées par prudence (voir ci-dessous).
- **`alanyaprivate`**, qui appartient à une autre application. On n'y touche pas.

## À faire plus tard

1. **Dans 2 à 4 semaines**, si rien n'a été signalé :
   - vider `media/` du seau Backblaze `alanyawork`, **sans toucher à `sauvegardes/`**. Des photos « vue unique » y ont encore une copie, et Backblaze garde même les versions effacées ;
   - vider `profilemedia` chez Backblaze ;
   - supprimer `alanyaprofile` chez Backblaze, qui est vide.
2. **Changer la clé du seau privé** : elle est apparue sur une capture d'écran le 10/10. Créer une nouvelle clé dans Cloudflare (Manage API Tokens), la mettre dans le `.env`, redémarrer, puis supprimer l'ancienne.
3. **Remplacer les adresses `r2.dev` par un sous-domaine à nous** (par exemple `media.alanyavox.com`). Cloudflare réserve les adresses `r2.dev` aux essais : leur débit est limité, et elles ne profitent pas de son cache mondial. Pour nos volumes actuels, ce n'est pas gênant, et les deux seaux publics ont un repli par le serveur. Ce qu'il faudra faire :
   - passer la gestion DNS d'un domaine chez Cloudflare. Aujourd'hui, alanyavox.com est chez OVH et alanya.cloud chez Hostinger, avec le courrier ; c'est donc une opération à préparer. L'autre solution est d'acheter un petit domaine dédié directement chez Cloudflare ;
   - brancher le sous-domaine sur chaque seau (Settings → Custom Domains) ;
   - changer `R2_PUBLIC_URL` et `R2_PROFIL_URL`, puis redémarrer ;
   - **le même jour, mettre à jour `SEAUX_MEDIAS` dans le web**.

   Il n'y a aucune donnée à migrer : les adresses publiques sont calculées au moment de la lecture.
4. **De temps en temps**, `node --env-file=.env scripts/avatars-profil.mjs --nettoyer`. La plateforme de l'équipe peut changer une photo directement en base, sans passer par nous ; ce nettoyage retire alors l'ancienne du seau public.

## Où est le code

| Quoi | Fichier (dépôt backend) |
|---|---|
| Choix du seau privé (Backblaze ou Cloudflare) | `src/modules/media/b2.ts` (`ciblePrivee`) |
| Seau des accueils et sonneries | `src/lib/adresse-publique.mjs`, `src/modules/media/b2-public.ts` |
| Seau des photos de profil | `src/lib/seau-profil.mjs`, `src/modules/media/r2-profil.ts`, `src/lib/avatar-profil.ts`, `src/app/api/avatars/[id]/route.ts` |
| Point de santé | `src/lib/etat-stockage.ts` |
| Politique de sécurité du web | `vite.config.ts` (dépôt web), liste `SEAUX_MEDIAS` |

Commits : backend `12a4bd5` (seau privé), `c27ac8d` (accueils et sonneries), `36d6975` (photos de profil) ; web `bec1265` et `513702e` (politique de sécurité).
