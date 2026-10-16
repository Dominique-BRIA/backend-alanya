# Remarques du professeur — spécification et suivi

> **À quoi sert ce fichier.** Il est la mémoire du chantier ouvert par la présentation
> de l'application au professeur. Il existe parce que le travail se fait depuis
> plusieurs comptes Claude : quand on change de compte, le contenu de la discussion est
> perdu, mais ce fichier reste. **Toute session qui reprend ce chantier commence par le
> lire**, puis consulte `git log` des trois dépôts pour les détails d'implémentation.
>
> **Règle de mise à jour** : celui qui termine un point change son état ici, dans le même
> lot que le code, et pousse. Un point jamais mis à jour vaut « non fait ».
>
> **Avant d'implémenter quoi que ce soit** : vérifier les commits récents de
> Dominique-Bria sur les trois dépôts. Il travaille en parallèle sur les mêmes
> fonctionnalités et du travail a déjà été annulé pour doublon (02/10/2026).

| Dépôt | Chemin local | Branche |
|---|---|---|
| Back-end (Next.js + `ws-server.mjs`) | `~/Documents/FLUTER/backend-alanya` | `feature/vocal-attente-loop` |
| Web (React/Vite) | `~/Documents/ALANYA/STAGE-WEB` | `main` |
| Mobile (Flutter) | `~/Documents/FLUTER/alanya` | `feat/chip-appel-callstyle` |

**Légende des états** — ⬜ à faire · 🟨 en cours · ✅ fait · 🔵 étude de faisabilité · ⛔ écarté (avec le motif)

---

## État d'avancement au 16/10/2026

### A. Compression et codec

#### A1 — Compression mobile : résultat attendu non obtenu 🟨
Le poids obtenu sur Android ne correspond toujours pas à celui du web. À re-diagnostiquer
sur le dernier APK (fabriqué par GitHub Actions — **ne jamais lancer Gradle en local**), en
mesurant les six grandeurs : résolution, débit et poids, avant et après.
Code : `lib/core/compression_video.dart`, `android/app/src/main/kotlin/com/alanya237/work/CompresseurVideo.kt`.

#### A2 — Web : bouton « meilleure qualité » absent pour la vidéo 🟨
La ligne « poids initial → poids final » s'affiche, mais le bouton de montée en qualité
n'apparaît que pour les photos. Attendu : comportement identique photo et vidéo.
Code : `app/(protected)/chats/[chatId]/chat.tsx` (condition `gain.niveauSuperieurPossible || niveau === "haute"`).

#### A3 — Seuil de déclenchement au débit ✅ *décidé le 16/10, implémentation à faire* ⬜
**Demande du professeur** : compresser toute vidéo dont le débit dépasse ~1,2 Mbit/s, et
viser directement le palier le plus bas.
**Décision prise** : on adopte **le déclencheur au débit** (le professeur a raison : le poids
d'un fichier vaut débit × durée, la définition ne fait que plafonner le détail que ce débit
peut porter) **et on garde l'escalier de définition** (une marche à la fois). On n'adopte pas
la descente directe au palier le plus bas : elle réglerait un problème de poids en sacrifiant
la définition, et rendrait illisible le texte d'une vidéo de cours — c'est précisément le cas
d'usage pour lequel le niveau haut a été fixé à 1080p.
**Levier de poids retenu si le professeur veut plus léger** : baisser le débit du palier 720p
de 1,6 à 1,2 Mbit/s (environ −25 % de poids, définition intacte), plutôt que descendre en 480p.
**Reste à trancher par le professeur** : plafond à 480p, oui ou non.
Code : `src/lib/video-compression.ts` (web, référence), `lib/core/compression_video.dart` (mobile).

#### A4 — Passage au codec H.265/HEVC ⛔ écarté le 16/10
**Motif** : un média HEVC n'est pas lisible dans la plupart des navigateurs. Un compte qui
reçoit un HEVC sur son téléphone peut se connecter au web le lendemain : le média devient
alors inaccessible. Les trois contournements ont été examinés et aucun ne tient :
- *transcodage côté serveur à la demande* — **impossible par construction** : le chiffrement
  de bout en bout interdit au serveur de lire le contenu du média ;
- *double encodage HEVC + H.264 à l'envoi* — double le stockage et le temps d'encodage sur
  le téléphone de l'expéditeur, pour un bénéfice nul chez lui ;
- *décodage HEVC logiciel dans le navigateur (WebAssembly)* — mémoire et lenteur
  disproportionnées sur un fichier de plusieurs dizaines de Mo, sans navigation dans la vidéo.

**On reste donc sur H.264** (`avc1`), avec repli VP9 puis VP8 en WebM pour les navigateurs
dépourvus d'encodeur H.264 (Firefox).
**Si le sujet est rouvert un jour**, la seule architecture viable est « HEVC au stockage +
repli H.264 fabriqué sur l'appareil de l'expéditeur », jamais un transcodage serveur.

#### A5 — Lenteur de la compression et de l'envoi ⬜ *diagnostiqué le 16/10*
**Constat** : chez nous, compression puis envoi sont perçus comme beaucoup plus longs que
chez WhatsApp. Trois causes structurelles trouvées dans le code web, par ordre d'impact :
1. **Tout est en série** : on compresse à 100 %, puis on chiffre, puis on téléverse. Le temps
   perçu est la somme des trois. Le MP4 est fabriqué en `fastStart: "in-memory"`, donc aucun
   octet ne peut partir avant la fin de l'encodage.
2. **L'accélération matérielle n'est jamais demandée** : `VideoEncoder.isConfigSupported` est
   appelé sans `hardwareAcceleration`, on prend donc ce que le navigateur décide — souvent un
   encodeur logiciel. Sur mobile, WhatsApp utilise l'encodeur matériel du téléphone.
3. **La compression tourne sur le fil principal**, elle entre en concurrence avec l'interface.
Leviers, du plus rentable au moins rentable : faire chevaucher encodage et téléversement ;
sonder `hardwareAcceleration: "prefer-hardware"` en premier ; déplacer le transcodage dans un
Worker ; enfin réduire le nombre de pixels (le levier du professeur).
Code : `src/lib/video-compression.ts:364` (sondage des codecs), `:472` (`fastStart`).

### B. Sécurité et identité

#### B1 — Second facteur à la connexion web (OTP) ⬜
Identifiant + mot de passe est jugé insuffisant. Code à usage unique délivré **dans
l'application Android**, saisi sur le web. Optionnel pour un particulier (réglage de compte),
automatique pour un compte entreprise.
Note : le service de vérification existe déjà côté API (`POST /api/v1/verifications` et
`/verifications/check`, voir `docs/2026-08-21-api-v1-integration.md`) ; rien ne l'utilise à la
connexion web.

#### B2 — Nom personnalisé par contact, affiché partout 🟨 *socle existant*
Le nom qu'un utilisateur donne à un contact doit s'afficher **partout où ce contact
apparaît** : liste des fils, en-tête de conversation, messages entrants, appels entrants et
sortants, notifications.
**Ce qui existe déjà** : la colonne `Contact.alias` (`prisma/schema.prisma:704`), l'API
(`/api/contacts`, `/api/contacts/[id]`), le champ « Alias (optionnel) » du formulaire de
contact sur le web. `/api/accounts/lookup` préfère déjà l'alias au nom public.
**Ce qui manque** : l'alias n'est utilisé que dans la recherche de contacts. Il n'est appliqué
ni aux conversations, ni aux appels, ni aux notifications, et **rien n'existe côté mobile**.
**Réserve technique à dire au professeur** : l'option « interdire aux autres de me renommer »
n'est pas tenable. On peut refuser de stocker l'alias sur le serveur, on ne peut pas empêcher
un client d'afficher un nom qu'il garde en local.

#### B3 — Documents sensibles : marquage à la descente ⬜
Au téléchargement, estamper le fichier avec le numéro Alanya de celui qui télécharge, la
marque de l'appareil, la date et l'heure. Le document ne doit pas pouvoir être repartagé.
**À préciser avec le professeur** : quels formats (PDF seulement, ou images aussi).
**Réserve technique** : « non repartageable » ne peut être qu'une restriction *dans*
l'application — une capture d'écran restera toujours possible. Le marquage est dissuasif et
traçant, pas bloquant. Il faut le présenter comme tel.

### C. Interopérabilité

#### C1 — Parité fonctionnelle de l'API publique ⬜
L'API doit transporter les mêmes types de messages que l'application — texte, photo, vidéo —
avec un rendu correct à l'arrivée. Usage visé : brancher l'API sur un back-end métier pour
qu'un message soit émis automatiquement quand un fichier passe d'un service à un autre.
Référence : `docs/2026-08-21-api-v1-integration.md`. À auditer point par point contre cette
exigence de parité (l'API v1 a été refaite le 21/08/2026 et personne ne l'avait encore
intégrée).

### D. Stockage

#### D1 — Organisation Cloudflare et rétention 🟨 *socle existant*
Demande : un espace dédié à l'entreprise (`alanyawork entreprise`), les échanges de
discussion avec **suppression du contenu après 30 jours**, les fichiers de profil et de
répondeur conservés à part.
**Ce qui existe déjà** : trois seaux R2 séparés — privé, public, profil — documentés dans
`docs/2026-10-11-cloudflare-r2.md`.
**Ce qui manque** : la règle de cycle de vie à 30 jours, et la séparation entreprise.

#### D2 — Coffre-fort documentaire ⬜
Un espace où l'utilisateur dépose ses documents. Recouvre le « Drive 2.0 » déjà prévu à la
feuille de route du 11/10 : albums Privé / Famille / Autres, 5 à 10 Go, albums partageables,
éléments privés masqués, accessible depuis n'importe quel appareil.

#### D3 — Application de bureau synchronisante ⬜ nouveau
Un logiciel sur l'ordinateur, à la manière de Dropbox : les fichiers déposés dans un dossier
remontent dans le compte et se retrouvent depuis n'importe quelle machine. Dépend de D2.

#### D4 — Limites d'envoi : 250 Mo et fichiers `.apk` 🟨
**Déjà en place** : plafond de 250 Mo côté mobile (`lib/core/plafond_media.dart:27`).
**À vérifier** : qu'aucun filtre de type ne bloque l'APK dans les deux sélecteurs de fichiers
(aucun filtre trouvé dans le code, mais la vérification n'a pas été faite à l'usage), et que
le plafond de 250 Mo est bien appliqué côté web.

### E. Confort d'usage

#### E1 — Affichage « Média chiffré en cours » ⬜
L'état transitoire affiché pendant le déchiffrement est jugé inesthétique (« avant, il y avait
un trait au milieu »). À redessiner en indicateur sobre.

#### E2 — Latence perçue du chemin chiffré ⬜
« Le problème n'est pas le chiffrement en tant que tel, c'est juste une petite lenteur. »
Mesurer le chemin complet d'un média chiffré — dérivation de clé, téléchargement,
déchiffrement, rendu — et optimiser le maillon le plus lent, chiffres en main. Distinct de A5,
qui porte sur l'envoi.

#### E3 — Filtres de visage en appel vidéo 🔵
Barbe, modification de la forme du visage, à la manière de Snapchat. Demande d'étude de
faisabilité, pas de réalisation immédiate.

---

## Journal

- **16/10/2026** — Remarques du professeur mises en spécification (14 points). Décisions :
  H.265 écarté (A4), escalier de définition conservé et déclencheur au débit adopté (A3),
  causes de la lenteur identifiées (A5). En attente d'arbitrage du professeur : plafond 480p.
  Vérification faite : les commits de Dominique-Bria des 15 et 16/10 portent tous sur la
  console de gestion (compte officiel « Alanya Work », diffusions, message de bienvenue, IA,
  modération, statistiques, ciblage entreprise, badges) — aucun recouvrement avec ces 14 points.
