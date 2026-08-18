# Contrat de l'API Développeur Alanya

**Rédigé pour être transmis tel quel** à l'équipe qui construit le tableau de
bord. Version du 18/08/2026, commit `64774e1`.

Ce document décrit ce qui est **gelé** — donc ce contre quoi on peut construire
sans risque de reprise — et ce qui reste **à décider**. Tout ce qui n'y figure
pas est susceptible de changer.

---

## 1. Deux API, deux publics

| | Qui appelle | Authentification |
|---|---|---|
| `/api/developer/*` | le **tableau de bord** | JWT Alanya (`Authorization: Bearer <access>`) |
| `/api/v1/*` | les **serveurs des développeurs** | clé API (`X-Api-Key` ou `Authorization: Bearer ak_…`) |

Ce sont deux surfaces distinctes. La console lit et écrit la configuration d'un
compte développeur ; l'API v1 est le produit que ce compte consomme.

## 2. Architecture retenue : le tableau de bord passe par son propre backend

Le navigateur du tableau de bord **n'appelle pas** notre API directement. C'est
le backend du tableau de bord qui nous appelle, et qui relaie.

Trois raisons, dont deux sont des garanties de sécurité :

- une **clé API dans du JavaScript de navigateur est une clé publiée** — elle
  est lisible dans l'onglet réseau et dans le bundle ;
- le jeton Alanya reste côté serveur, hors de portée d'une extension ou d'un
  script tiers ;
- aucune dépendance à notre configuration CORS, donc aucun couplage entre le
  déploiement du tableau de bord et le nôtre.

**CORS reste néanmoins ouvert** (`Access-Control-Allow-Origin: *`, en-têtes
`Content-Type, Authorization, X-Api-Key`) : une console « essayer cette
requête » depuis le navigateur fonctionne. `X-Api-Key` a été ajouté à cette
liste le 18/08/2026 — sans lui, le préflight échouait silencieusement.

## 3. ⚠️ À décider avant la mise en production : la session de la console

**C'est le point qui mordra en production s'il n'est pas tranché.**

Alanya applique une règle de session unique : au plus **un mobile et un poste**
par compte. Un tableau de bord est un poste. Avec le réglage par défaut
(`users.appareil_total = 2`), la limite « poste » vaut 1 — donc **se connecter
au tableau de bord déconnecte l'utilisateur d'Alanya Web, et inversement**.

Ce n'est un défaut d'aucun des deux produits : c'est une décision d'architecture
qui n'a jamais été prise, la console n'ayant jamais eu de client.

Deux issues, compatibles entre elles :

1. **`appareil_total = 3` sur les comptes développeurs.** Aucun code, effet
   immédiat, réglable depuis la plateforme. Débloque le développement dès
   aujourd'hui. Fragile : c'est un réglage par compte qu'il faut penser à poser.
2. **Une famille « console » distincte**, hors du décompte des postes. Une
   dizaine de lignes côté Alanya, et le problème disparaît par construction.

> Recommandation : (1) tout de suite pour ne pas bloquer, (2) avant la mise en
> production.

---

## 4. Contrat gelé

### 4.1 Forme des réponses

Succès — la donnée, sans enveloppe. Les routes `/api/v1/messages/*` conservent
en plus la forme de WhatsApp Cloud API, pour rester interchangeables avec un
client existant.

Erreur — **toujours** cette forme :

```json
{ "error": { "message": "Solde de crédits insuffisant.", "code": "INSUFFICIENT_CREDITS" } }
```

`message` est destiné à l'humain et **peut être reformulé** ; `code` est
destiné au programme et ne change pas. Ne jamais brancher sur `message`.

### 4.2 Codes d'erreur

| `code` | HTTP | Signification |
|---|---|---|
| `API_KEY_MISSING` | 401 | Aucun en-tête d'authentification |
| `API_KEY_INVALID` | 401 | Clé inconnue, désactivée, ou compte absent |
| `INVALID_REQUEST` | 400 | Champ obligatoire manquant ou vide |
| `RECIPIENT_NOT_FOUND` | 404 | Le numéro ne correspond à aucun compte Alanya |
| `INSUFFICIENT_CREDITS` | **402** | Solde insuffisant |
| `RATE_LIMITED` | **429** | Trop de requêtes |
| `INTERNAL_ERROR` | 500 | Défaillance interne |

### 4.3 🔴 402 et 429 ne veulent pas dire la même chose

Les deux disent « refusé », mais la conduite à tenir est **opposée** :

- **402** → il faut **recharger**. Réessayer ne servira jamais à rien.
- **429** → il faut **attendre**, puis réessayer.

Jusqu'au 18/08/2026, le solde insuffisant répondait 429. Un client bien écrit
réessayait donc en boucle une requête que seul un paiement pouvait débloquer.
La séparation est faite ; elle ne bougera plus.

### 4.4 Identifiant d'un message

`POST /api/v1/messages/send` rend :

```json
{ "messages": [{ "id": "wamid.<uuid>", "message_status": "accepted" }] }
```

La partie après `wamid.` est **l'identifiant réel du message** en base. C'est la
même valeur que celle portée par la ligne de facturation et par le webhook —
elle permet donc de construire un écran « détail d'un message ».

> Auparavant cet identifiant était dérivé de l'horloge et d'un tirage aléatoire :
> il ne désignait rien. Tout écran bâti sur l'ancienne valeur est à revoir.

### 4.5 `GET /api/developer/logs`

| Paramètre | Défaut | Notes |
|---|---|---|
| `limit` | 50 | borné à 100 |
| `cursor` | — | `id` du dernier log reçu ; renvoie les précédents |
| `depuis` / `jusqua` | — | bornes ISO-8601 ; une date illisible est ignorée, pas rejetée |

Réponse :

```json
{
  "logs": [ { "id": "…", "endpoint": "…", "method": "POST",
              "statusCode": 200, "latencyMs": 142,
              "keyPrefix": "ak_live_a1b", "createdAt": "…" } ],
  "nextCursor": "…ou null",
  "total": 1284,
  "avgLatencyMs": 138,
  "successRatePercent": 97
}
```

⚠️ **`avgLatencyMs`, `successRatePercent` et `total` portent sur toute la
période filtrée**, pas sur la page. Ils ne changent donc pas quand on pagine.
(Ils étaient auparavant calculés sur la page : l'indicateur variait au fil de la
pagination.)

`nextCursor` à `null` signifie qu'il n'y a plus rien après.

### 4.6 Portée des données

Les cinq routes de console résolvent le compte développeur depuis le jeton, puis
filtrent dessus. **Un compte ne peut voir que ses propres données** — clés,
logs, webhooks, espaces de travail, solde. Aucun paramètre ne permet de viser un
autre compte.

---

## 5. Ce qui va encore changer

Ces chantiers **ne toucheront pas** au contrat ci-dessus. Ils sont listés pour
que le tableau de bord prévoie la place, pas pour être attendus.

| # | Lot | Effet visible côté console |
|---|---|---|
| 2 | Session console | Voir §3 |
| 3 | Sécurité | `RATE_LIMITED` devient réellement émis ; les clés `ak_test_` cessent d'envoyer de vrais messages ; la signature des webhooks passe à un HMAC |
| 4 | Facturation | Le solde réservé pendant un appel est enfin libéré ; un échec d'envoi rembourse le crédit |
| 5 | Justesse | Diffusion temps réel des messages envoyés par l'API |

**Sur les webhooks** : l'en-tête `X-Alanya-Signature` transmet aujourd'hui le
secret en clair — il ne permet donc rien de vérifier. Il portera un
`HMAC-SHA256(corps, secret)`. **Ne pas documenter la vérification avant ce
changement.**

**Sur les clés de test** : aujourd'hui `ak_test_` envoie de vrais messages à de
vrais utilisateurs et débite de vrais crédits. Ne pas présenter le bac à sable
comme sûr tant que le lot 3 n'est pas livré.

---

## 6. Ce qu'il nous faut de votre côté

1. La ou les **origines** du tableau de bord, si vous appelez malgré tout depuis
   le navigateur — pour restreindre `Access-Control-Allow-Origin`, aujourd'hui à `*`.
2. Votre **choix sur le §3** (session de la console).
3. Les **écrans prévus**, même en maquette : si l'un d'eux a besoin d'un champ
   qui n'est pas dans ce document, il vaut mieux l'ajouter au contrat maintenant
   qu'après votre livraison.

*Questions et corrections : elles se traitent dans ce document, qui est versionné
avec le code de l'API.*
