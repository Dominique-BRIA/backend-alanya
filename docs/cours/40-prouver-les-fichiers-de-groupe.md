# Chapitre 40 — Prouver que les fichiers d'un groupe sont chiffrés

> **Où nous en sommes.** 10/10/2026. Les fichiers d'un groupe chiffré
> **étaient** chiffrés depuis le lot 3. Mais la **preuve** était plus faible
> que pour le texte. Ce chapitre ne change pas une ligne de l'application : il
> change ce que les tests **montrent**.
>
> Web `03360c9` (bancs), mobile `61dea59` (tests).

---

## 1. « Ça marche » n'est pas « c'est prouvé »

Le user avait cru que les fichiers des groupes partaient en clair : une
ancienne phrase de l'application le laissait entendre (chapitre 38). En
vérifiant, on a trouvé un vrai trou… dans les **tests** :

| Banc | Ce qu'il vérifiait | Ce qu'il ne vérifiait pas |
|---|---|---|
| Web (groupe) | Bob reçoit le **descripteur** (l'identifiant du fichier) | que Bob puisse **ouvrir** le fichier |
| Mobile (groupe) | rien sur les fichiers | tout |
| Mobile ↔ web | du **texte** seulement | les fichiers |

Un descripteur qui arrive ne prouve pas grand-chose. Imaginons une clé mal
recopiée, ou un oubli de l'empreinte dans la charge : le descripteur
arriverait quand même, et le fichier ne s'ouvrirait jamais.

> 🎓 **Leçon.** Un test doit aller jusqu'à **l'effet que voit
> l'utilisateur**. Ici, ce n'est pas « le message est arrivé », c'est « la
> photo s'affiche ». Tout ce qui s'arrête avant laisse un trou.

## 2. Le rappel : comment voyage un fichier de groupe

1. L'appareil tire une **clé neuve** pour ce fichier, et le chiffre
   (AES-256-GCM par blocs de 64 Ko, chapitre « médias »).
2. Il téléverse le **chiffré** ; le serveur le range sans pouvoir le lire.
3. Le **descripteur** (identifiant, clé, empreinte, taille, type, nom,
   dimensions) part **dans le chiffré de groupe**, comme un texte.
4. Chaque membre déchiffre le message, télécharge le chiffré, vérifie
   l'empreinte, puis le déchiffre avec la clé du descripteur.

Le serveur ne voit en clair que l'**identifiant** du fichier (`mediaIds`),
parce qu'il doit savoir quel fichier rattacher au message.

## 3. Ce que prouvent maintenant les tests

### Mobile — `test/e2ee_groupe_fil_test.dart`, groupe ⑦

Sur le vrai code de l'application, avec la vraie bibliothèque Signal :

- une « photo » de **200 Ko** (plusieurs blocs) est envoyée par Alice ;
  Bob, Carole **et** Alice l'ouvrent, **octet pour octet** ;
- tout ce que le serveur a reçu est enregistré, puis fouillé : **ni la
  clé, ni l'empreinte, ni le nom, ni la légende** n'y figurent ; seul
  l'identifiant du fichier est en clair ;
- un fichier dont **un seul bit** a changé est refusé
  (`FichierInvalide`) ;
- un ancien membre, qui a oublié la clé du groupe, n'obtient **pas** celle
  du fichier.

### Web — `scripts/e2ee-groupe-web.mjs`, étape ⑤

Bob **télécharge** le fichier — il n'a rien en cache, il n'est pas
l'expéditeur — et l'ouvre avec la clé reçue dans le chiffré de groupe. Puis
on fouille la ligne du message en base : ni légende ni nom.

### Bout en bout — `scripts/e2ee-groupe-mobile-web.mjs`

Le plus fort : deux **implémentations différentes** (Dart et TypeScript)
contre le **vrai** serveur.

- **②bis** le téléphone envoie un fichier ; le navigateur le télécharge et
  l'ouvre ;
- **③** le navigateur envoie un fichier ; le téléphone le télécharge
  (`GET /api/media/<id>`) et l'ouvre.

Le contenu contient des **accents** (« éèà », « ùç ») : un encodage
différent entre Dart et JavaScript se verrait tout de suite.

## 4. Les erreurs rencontrées, et leurs solutions

### a) `Identifier 'ligne' has already been declared`

En ajoutant la vérification au banc web, j'ai appelé ma variable `ligne`…
qui existait déjà plus haut dans la même fonction. JavaScript refuse de
déclarer deux fois un `const` dans la même portée : le banc ne démarrait
même pas.

**Solution.** Un nom propre à l'étape : `ligneMedia`.

> 🎓 **Leçon.** Dans un long script de test, préfixer les variables par leur
> étape (`ligneMedia`, `ligneFichier`) évite les collisions — et dit au
> lecteur à quoi elles servent.

### b) Le test Dart lisait un seul message puis s'arrêtait

La boucle du test réel s'arrêtait dès que le **texte** du navigateur était
lu. Le fichier, envoyé juste après, n'aurait jamais été attendu.

**Solution.** La boucle attend les **deux** (`lu` et `fichierLu`), et
distingue un message texte d'un message fichier par la présence du
descripteur.

## 5. Les preuves

| Banc | Résultat |
|---|---|
| Mobile `e2ee_groupe_fil_test.dart` | 15 ✓ (dont 4 nouveaux) |
| Web `e2ee-groupe-web.mjs` | 22 ✓ — TOUT EST VERT |
| Bout en bout `e2ee-groupe-mobile-web.mjs` | 23 ✓ — TOUT EST VERT |
