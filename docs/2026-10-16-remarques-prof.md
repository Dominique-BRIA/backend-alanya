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

#### A1 — Compression mobile : résultat attendu non obtenu 🟨 *audité le 16/10*
Le poids obtenu sur Android ne correspond toujours pas à celui du web. À re-mesurer sur le
prochain APK (fabriqué par GitHub Actions — **ne jamais lancer Gradle en local**), en relevant
les six grandeurs : résolution, débit et poids, avant et après.

**Audit de la chaîne mobile du 16/10, point par point** — ce qui a été vérifié et trouvé SAIN,
à ne pas re-diagnostiquer :
- les commits de compression des 12 et 13/10 sont bien sur `origin` : l'APK du jour les contient ;
- la durée rendue par `getMediaInfo` est en **millisecondes** (`METADATA_KEY_DURATION`), donc le
  débit mesuré côté Dart est juste ;
- les deux bouts du canal `alanya/compression_video` s'accordent (chemin, bords, débit), et les
  callbacks du transcodeur reviennent sur le fil principal ;
- le chemin d'envoi utilise bien les octets compressés (`_fichiers`, jamais `widget.files`).

**Ce qui était cassé, et qui l'est encore ?** Un seul défaut trouvé, et il était à moi : le
retour SUCCÈS du module ne portait pas `definitionAutreNiveau` — le cas normal, donc le seul que
l'utilisateur voit. Corrigé (`f61d136`).

**La vraie leçon** : les 27 bancs vidéo n'éprouvaient que des FONCTIONS PURES. Un champ oublié
entre le module et l'écran passait inaperçu. `test/compression_video_bout_en_bout_test.dart`
monte désormais le trajet complet, les deux canaux natifs simulés.

**Divergence web/mobile connue et assumée** : au niveau HAUT, sur une source déjà en 1080p, le
transcodeur mobile peut décider de laisser passer la piste telle quelle (la définition visée
égale celle de la source) et ne produit alors aucun fichier ; la vidéo part intacte. Le web, lui,
ré-encode à un débit plus bas. Le résultat mobile est plus lourd mais de meilleure qualité, ce
qui est défendable pour un bouton qui promet « meilleure qualité ». À ne pas « corriger » sans y
réfléchir.
Code : `lib/core/compression_video.dart`, `android/app/src/main/kotlin/com/alanya237/work/CompresseurVideo.kt`.

#### A2 — Web : bouton « meilleure qualité » absent pour la vidéo ✅ 16/10 (web `5ac99b5`, mobile `e806354`)
**Ce n'était pas un défaut d'affichage.** `niveauSuperieurPossible` posait encore la question
d'avant l'escalier — « la source dépasse-t-elle 720p ? » — alors que depuis le 13/10 le niveau
normal descend **une marche en dessous**. Une vidéo filmée en 720p partait donc en 360p et
aucun bouton ne permettait de remonter. La question juste est comparative : le niveau haut
donne-t-il une définition plus fine que le normal ? Le même défaut dormait côté photo, entre
640 et 1600 px — invisible sur une photo de téléphone, qui dépasse toujours le plafond.
Et l'étiquette mentait : elle annonçait « Envoyer en 1080p » même quand la source ne pouvait
pas le rendre. Elle annonce maintenant la définition qu'elle va produire, en neuf langues
(clés `media_envoyer_definition` / `media_revenir_definition`).

#### A3 — Seuil de déclenchement au débit ✅ 16/10 (web `5ac99b5`, mobile `e806354`)
**Demande du professeur** : compresser toute vidéo dont le débit dépasse ~1,2 Mbit/s, et
viser directement le palier le plus bas.
**Décision prise** : on adopte **le déclencheur au débit** (le professeur a raison : le poids
d'un fichier vaut débit × durée, la définition ne fait que plafonner le détail que ce débit
peut porter) **et on garde l'escalier de définition** (une marche à la fois). On n'adopte pas
la descente directe au palier le plus bas : elle réglerait un problème de poids en sacrifiant
la définition, et rendrait illisible le texte d'une vidéo de cours — c'est précisément le cas
d'usage pour lequel le niveau haut a été fixé à 1080p.
**Ce qui est en place depuis le 16/10** :
- `SEUIL_DEBIT` = 1 450 000 bits/s, soit le débit du palier 720p (1 200 000) **plus la marge
  du son** (250 000). Sous ce débit de fichier, on ne touche à rien, quelle que soit la
  définition ;
- le palier 720p descend de 1,6 à **1,2 Mbit/s** — le chiffre du professeur — soit un quart
  de poids en moins à définition intacte ;
- l'escalier de définition est inchangé : >720→720, 361-720→360, 241-360→240, ≤240 rien.

**Ce seuil unique a remplacé la garde contre la cascade** du 13/10, qui reconnaissait nos
propres fichiers à leur forme (petit côté sur un palier, débit sous celui du palier). Il n'y a
plus de forme à reconnaître : le seuil **est** le débit du palier 720p plus le son, donc aucune
de nos sorties ne le dépasse et aucune ne redéclenche la compression. L'invariant tient par
construction et un banc le vérifie palier par palier
(`test/compression_video_test.dart`, 27 cas, tous verts).

**PLAFOND ABSOLU À 720p depuis le 17/10** (web `9e4837f`, mobile `6796bea`) : le niveau haut
visait 1080p, le user l'a ramené à 720 — « le 1080 ne doit pas être là ». Si la source est déjà
sous 720p, le niveau haut ne compresse plus du tout : elle part entière.
**LES DEUX NIVEAUX, EN UN TABLEAU** (web `1fa5027`, mobile — même règle) :

| Source | Niveau normal (défaut) | Bouton « meilleure qualité » |
|---|---|---|
| plus de 720p | 720p à 1,2 Mbit/s | **720p à 2,5 Mbit/s** |
| 241 à 720p | une marche plus bas (360 ou 240) | **l'original, intact** |
| 240p ou moins | rien | rien — aucun bouton, aucune flèche |
| déjà sous 1,45 Mbit/s | rien | rien — aucun bouton, aucune flèche |

🔴 **RIEN N'EST JAMAIS AGRANDI** : sous 720p, le niveau haut ne touche à rien. C'est le sens
historique du bouton — « envoyer la taille originale » — que le plafond du professeur borne à
720p sans le remplacer.
⚠️ **AU-DESSUS DE 720p, C'EST LE DÉBIT QUI DISTINGUE LES DEUX NIVEAUX**, et non la définition :
2,5 Mbit/s contre 1,2. Sans cela les deux niveaux rendaient le même fichier et le bouton avait
été caché — ce que le user a refusé le 17/10 : « les deux boutons doivent être toujours là ; le
seul moment où on ne voit rien, c'est quand l'application ne compresse pas ».
⚠️ Une vidéo déjà plus légère que 2,5 Mbit/s part intacte même au-dessus de 720p : le plafond
borne ce que nous PRODUISONS, il n'oblige pas à dégrader un fichier déjà léger.
🔴 **ET C'EST CE QUI A SUPPRIMÉ LA DIVERGENCE WEB/MOBILE** décrite en A1 : plus aucun cas où la
définition visée égale celle de la source, donc plus de piste laissée passer par le transcodeur
natif. Le prorata de surface a disparu des deux côtés avec le plafond variable qui le justifiait.

**Reste à trancher par le professeur** : plafond à 480p, oui ou non. Lui présenter le 720p à
1,2 Mbit/s comme alternative — à 480p le texte d'une vidéo de cours devient illisible.
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

#### A5 — Lenteur de la compression et de l'envoi 🟨 *diagnostiqué le 16/10, 1 levier sur 4*
**Constat** : chez nous, compression puis envoi sont perçus comme beaucoup plus longs que
chez WhatsApp. Trois causes structurelles trouvées dans le code web, par ordre d'impact :
1. **Tout est en série** : on compresse à 100 %, puis on chiffre, puis on téléverse. Le temps
   perçu est la somme des trois. Le MP4 est fabriqué en `fastStart: "in-memory"`, donc aucun
   octet ne peut partir avant la fin de l'encodage.
2. **L'accélération matérielle n'est jamais demandée** : `VideoEncoder.isConfigSupported` est
   appelé sans `hardwareAcceleration`, on prend donc ce que le navigateur décide — souvent un
   encodeur logiciel. Sur mobile, WhatsApp utilise l'encodeur matériel du téléphone.
3. **La compression tourne sur le fil principal**, elle entre en concurrence avec l'interface.
⚠️ **Contrainte posée par le user le 16/10** : la compression doit RESTER dans la page de
prévisualisation, avec sa progression, la ligne « initial → final » et le bouton de meilleure
qualité. On ne copie donc pas WhatsApp, qui ne compresse qu'après l'appui sur « Envoyer ».
Le chevauchement doit se faire **sans** déplacer la compression : on téléverse le fichier
compressé pendant que l'utilisateur écrit sa légende, et on annule si le niveau change.

⚠️ **Le biais de la comparaison, à garder en tête** : WhatsApp Web ne transcode pas la vidéo,
il envoie le fichier tel quel ; et sur mobile WhatsApp utilise l'encodeur matériel du
téléphone. Une partie de sa « vitesse » consiste à ne pas faire le travail.

Leviers, du plus rentable au moins rentable :
1. ⬜ faire chevaucher encodage/chiffrement et téléversement (le gain perçu le plus grand) ;
2. ✅ **16/10** — sonder `hardwareAcceleration: "prefer-hardware"` avant d'accepter l'encodeur
   logiciel : deux passes, les trois profils H.264 en matériel d'abord ;
3. ⬜ déplacer le transcodage dans un Worker (l'interface cesse d'être bloquée) ;
4. ⬜ réduire le nombre de pixels — le levier du professeur, le seul qui coûte de la qualité.
Mesure : `msEncodage` est désormais rendu avec le résultat de la compression web. Il reste à
mesurer le chiffrement et le téléversement.
Code : `src/lib/video-compression.ts` (`configurationAvc`, `fastStart: "in-memory"`).

### B. Sécurité et identité

#### B0 — Le code de sécurité dans les paramètres d'une discussion ✅ 16/10 (web `26cbd34`, mobile `314e318`)
**Demande du user** : dans les paramètres d'une discussion, l'entrée « Chiffrement · Vérifier le
code de sécurité » doit exister sur le web comme sur le mobile, et elle ne doit **rien activer**
— pas de bouton « activer », pas de mot de passe demandé. Elle montre le code de sécurité (et
son QR). L'activation du chiffrement vit en **un seul endroit** : les réglages de l'application.

**Web** : l'écran de comparaison existait mais plus rien ne l'ouvrait depuis le retrait du
bouclier de l'en-tête le 12/10. Il vit maintenant dans le panneau d'infos de la discussion.
⚠️ Piège rencontré : pour une conversation à deux, `ConvInfo.members` porte une entrée dont
l'`id` est celui de la CONVERSATION — un code calculé là-dessus ne correspond à personne. D'où
le champ `pairUserId`, renseigné par les deux constructeurs.
**Mobile** : la rangée menait à l'activation (mot de passe + création de l'archive) dès que la
conversation n'était pas encore chiffrée. ⚠️ **La création de l'archive aux deux serrures
n'existait QUE là** : elle est passée dans l'écran « Sauvegarde chiffrée » des réglages, sans
quoi le défaut du 26/09/2026 revenait (déconnexion ⇒ tous les messages chiffrés vides).
**Les deux** : le code se calcule désormais sans attendre un premier message — la session est
ouverte à la demande (paquet de pré-clés, signature vérifiée). Vérifier AVANT d'écrire est
précisément l'usage d'un code de sécurité.

**Reste ouvert** : le user a signalé le 16/10, sur l'APK de 10 h, « le téléphone n'a pas pu
générer la clé de chiffrement ». Ce message venait de la branche `echecDemarrage` de l'ancienne
activation ; il signale que **cet appareil** n'a pas réussi à préparer ses clés au démarrage.
La cause reste à trouver (`e2ee_fournisseur.dart:256`) — le message a déménagé avec l'activation,
le défaut qu'il révèle n'est pas réglé.

#### B1 — Second facteur à la connexion web (OTP) ✅ 18/10, PAR DOMINIQUE (web `3c1d8c3`)
« Connexion en deux étapes : saisir le code reçu dans l'application ». ⚠️ **Ne pas le refaire.**
Reste à vérifier à l'usage, s'il n'y a pas déjà été : optionnel pour un particulier, automatique
pour un compte entreprise.
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

#### B3 — Documents sensibles : marquage à la descente ✅ 18 au 26/10, PAR DOMINIQUE
Huit commits côté web (`d47a9df` → `3a47772`) : le navigateur ne les ouvre ni ne les transfère,
puis les ouvre en signant ce qui sort ; filigrane lisible après un passage par WhatsApp ;
empreinte dans les PDF et l'audio ; signature incrustée aux quatre bords des vidéos ; partage
bloqué et recherche par empreinte ; PDF sensible protégé côté web. ⚠️ **Ne pas le refaire.**
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

**LE SEAU ENTREPRISE, PRÉCISÉ PAR LE PROFESSEUR (27/10)** — un grand espace entreprise, et
dedans DEUX groupes seulement :
1. `call-center/` — tous les audios des centres d'appels des entreprises créées depuis l'espace
   administrateur (celui de Choufouane, **pas** la console de Dominique). L'espace admin écrit,
   l'application lit.
2. `archives/` — le suivi des réclamations : résumés, rapports, pièces jointes.
Tout le reste ne bouge pas : discussions, appels entre employés, photos de profil → stockage
général de l'application.

🔴 **R2 N'A PAS DE DOSSIERS, ET CELA CHANGE TOUTE LA PROCÉDURE.** Comme chez S3, un « dossier »
n'est qu'un PRÉFIXE dans le nom de l'objet : `call-center/x.mp3` est un fichier dont le nom
contient une barre oblique. Il n'y a donc RIEN à créer — le dossier paraît au premier fichier
déposé et disparaît avec le dernier. Ce qui se décide vraiment, c'est la convention de nommage
(que le code écrira) et les règles de cycle de vie, qui elles existent pour de bon et
s'appliquent PAR PRÉFIXE.

**Convention proposée** (en attente du nom exact du seau) :
```
<seau entreprise>/call-center/<idEntreprise>/<fichier.mp3>
<seau entreprise>/archives/<idEntreprise>/<année>/<idDossier>/<fichier>
```
L'identifiant d'entreprise juste après le préfixe : deux entreprises ne peuvent pas se
télescoper sur un même nom, et on peut effacer ou archiver UNE seule entreprise d'un geste.
Minuscules, sans accent ni espace — ces noms finissent dans des adresses web.

⚠️ **AUCUNE RÈGLE 30 JOURS SUR CE SEAU.** Les audios de call center sont de la CONFIGURATION,
pas du trafic : une règle de 30 jours rendrait les standards muets au bout d'un mois. La règle
des 30 jours appartient au seau des médias de discussion.

**Bloqué sur deux réponses du user** : le nom exact du seau tel qu'il s'affiche dans Cloudflare
(et s'il est public ou privé), et OÙ VIT LE CODE de l'espace administrateur de Choufouane —
aucun de nos trois dépôts n'en contient, et c'est lui qui devra écrire sous ces préfixes.

#### D2 — Coffre-fort documentaire ⬜
Un espace où l'utilisateur dépose ses documents. Recouvre le « Drive 2.0 » déjà prévu à la
feuille de route du 11/10 : albums Privé / Famille / Autres, 5 à 10 Go, albums partageables,
éléments privés masqués, accessible depuis n'importe quel appareil.

#### D3 — Application de bureau synchronisante ⬜ nouveau
Un logiciel sur l'ordinateur, à la manière de Dropbox : les fichiers déposés dans un dossier
remontent dans le compte et se retrouvent depuis n'importe quelle machine. Dépend de D2.

#### D4 — Limites d'envoi : 300 Mo et fichiers `.apk` 🟨
**300 Mo depuis le 17/10** (demande du user), à trois endroits qui doivent rester égaux :
`MEDIA_MAX_SIZE_MB` (`src/lib/env.ts`, `fec6170`), `TAILLE_MEDIA_MAX_MO` du web (`9e4837f`) et
`plafondMediaOctets` du mobile (`6796bea`).
⚠️ **IL RESTE LE RELAIS, ET SANS LUI LE 300 Mo EST UN MENSONGE** : `client_max_body_size` vaut
1 Mo par défaut chez nginx. Un fichier accepté aux deux écrans revient alors en 413 après
plusieurs minutes de téléversement. À poser sur le VPS (sauvegarde, `nginx -t`, puis `reload`) :

```nginx
client_max_body_size 320m;   # 300 Mo + la marge du multipart
client_body_timeout   120s;
proxy_request_buffering off;  # on streame au lieu de tamponner 300 Mo sur disque
proxy_read_timeout    600s;
proxy_send_timeout    600s;
send_timeout          600s;
```
La voie des morceaux n'envoie qu'un morceau par requête (1 Mio par défaut,
`ENVOI_TAILLE_MORCEAU_KO`, 8 Mio au plus) : c'est la voie d'un seul bloc —
statuts, répondeur, fichiers sous 1 Mio — qui a besoin des 320 Mo. Prévoir aussi la place disque
de `ENVOIS_MORCEAUX_DIR` (`./storage/envois`) : un envoi y vit à sa taille finale, et la
réservation refuse en 507 s'il reste moins d'1 Gio de marge.
**À vérifier** : qu'aucun filtre de type ne bloque l'APK dans les deux sélecteurs de fichiers
(aucun filtre trouvé dans le code, mais la vérification n'a pas été faite à l'usage), et que
le plafond de 250 Mo est bien appliqué côté web.

#### D5 — L'envoi ne disparaît plus, et il reprend ✅ 17/10 (web `9e4837f`)
**Signalé par le user** : « quand ça coupe, surtout sur le web, ça disparaît totalement de la
discussion » — alors que le fichier non envoyé doit rester avec son horloge. Et : « quand la
connexion revient, ça doit seulement continuer au lieu de recommencer ».

Trois défauts derrière ce seul symptôme, tous côté web :
1. **une seule panne était reconnue**, le statut 0. Un téléversement long meurt plutôt sur un
   502/503/504 : le relais s'impatiente avant le serveur et répond lui-même. C'était traité
   comme un refus définitif → bulle retirée, fichier jeté. Les cinq statuts 408, 429, 502, 503,
   504 disent « pas cette fois », pas « jamais ». ⚠️ 413 reste définitif, lui — le remettre en
   file le ferait échouer en boucle, en silence ;
2. **rien ne réessayait** : les trois signaux de la file (montage, `online`, reconnexion du
   WebSocket) supposent que le réseau est TOMBÉ, alors qu'un envoi coupé par le relais échoue
   connexion debout. Une minuterie d'une minute réveille la file tant qu'il y reste quelque
   chose, et ne touche à rien quand elle est vide ;
3. **la file renvoyait le fichier entier** par la route d'un seul bloc. Un envoi coupé à 90 %
   repartait de zéro : à 1 Mbit/s en montée, 300 Mo demandent quarante minutes. Elle passe
   désormais par `/api/media/envois` et demande au serveur ses `manquants` — **le mobile le
   faisait déjà** (`lib/features/chat/envoi_morceaux/`), le web était en retard. La réservation
   (`envoiId`, `envoiJeton`) est rangée dans la file DÈS QU'ELLE EXISTE, avant le premier
   morceau, et les morceaux déjà reçus comptent dans l'avancement affiché.

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

- **27/10/2026** — Mise à jour sur les dépôts : Dominique a livré **B1** (connexion en deux
  étapes) et **B3** (documents sensibles signés et non repartageables), plus des chantiers hors
  liste (stickers, mode maintenance, console de gestion, diffusions, bienvenue). Les deux items
  passent à ✅ : ne pas les refaire.
  🐛 Défaut signalé par le user et corrigé : **la photo de profil ne pouvait pas changer sur le
  web** (« impossible de joindre le serveur »). Rien à voir avec la migration R2 —
  `src/lib/avatar.ts` faisait `fetch()` sur une adresse `data:`, que notre propre `connect-src`
  refuse. Le message venait de notre traduction d'une panne réseau, alors que le serveur n'avait
  jamais été appelé. La data-URL est maintenant décodée en mémoire, sans élargir la CSP.
  ⚠️ **Troisième défaut de cette famille** : `blob:` manquait pour l'aperçu des PDF (06/10), un
  hôte d'images manquait pour les avatars de l'équipe (02/10). Toute ressource lue par `fetch`
  doit être déclarée dans `connect-src`, ou ne pas passer par `fetch`.

- **17/10/2026** — Plafond vidéo ramené à 720p des deux côtés (A3), ce qui a supprimé la
  divergence de A1 ; plafond des fichiers porté à 300 Mo dans les trois dépôts (D4) ; envoi web
  rendu reprenable et persistant (D5). Bancs : 484 mobiles verts, `tsc` et `npm run build`
  verts. ⚠️ Reste au user : la configuration nginx de D4, sans laquelle le 300 Mo ne tient pas.
- **16/10/2026, nuit** — Audit de la chaîne mobile demandé par le user (A1) : un défaut trouvé
  et corrigé, cinq points vérifiés sains, un banc de bout en bout ajouté. Code de sécurité
  rendu atteignable sur le web et dépouillé de son activation sur le mobile (B0). Bancs : 487
  mobiles verts (6 ignorés, pré-existants), `tsc` et `npm run build` verts.
  ⚠️ `backend-alanya` et `alanya` attendent toujours une poussée manuelle : pas d'identifiant
  HTTPS sur la machine, `gh` non connecté, et repointer leur `origin` vers SSH est refusé par
  le classifieur de permissions.
- **16/10/2026, soir** — Livré : A2 et A3, web (`5ac99b5`, poussé) et mobile (`e806354`, à
  pousser), plus le premier des quatre leviers de A5. Bancs : 27 cas vidéo + la ligne d'envoi +
  la parité des neuf langues, tous verts ; `tsc` et `npm run build` verts côté web.
  ⚠️ Les dépôts `backend-alanya` et `alanya` ont un `origin` en HTTPS sans identifiants
  enregistrés — seul le dépôt web est en SSH. Leurs commits attendent donc une poussée manuelle
  du user, ou le passage de leur `origin` en SSH.
- **16/10/2026** — Remarques du professeur mises en spécification (14 points). Décisions :
  H.265 écarté (A4), escalier de définition conservé et déclencheur au débit adopté (A3),
  causes de la lenteur identifiées (A5). En attente d'arbitrage du professeur : plafond 480p.
  Vérification faite : les commits de Dominique-Bria des 15 et 16/10 portent tous sur la
  console de gestion (compte officiel « Alanya Work », diffusions, message de bienvenue, IA,
  modération, statistiques, ciblage entreprise, badges) — aucun recouvrement avec ces 14 points.
