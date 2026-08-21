# API Alanya v1 — guide d'intégration serveur à serveur

**Rédigé pour être transmis tel quel.** Version du 21/08/2026.

Destinataire : l'équipe dont la plateforme consomme `/api/v1/*` avec une clé API.

🔴 **Cette API n'est pas un produit vendu à des développeurs extérieurs.** Elle
sert la plateforme de l'équipe, qui porte son propre mécanisme de paiement. Ce
que nous livrons, c'est **un moyen de communiquer avec les utilisateurs
Alanya**. Il n'y a donc ni crédits, ni solde, ni bac à sable.

> **Personne n'ayant encore intégré cette API, elle a été refaite en une fois.**
> Si vous avez lu une version antérieure de ce document ou du contrat du
> 18/08/2026 : les noms de routes, les noms de champs et la charge des webhooks
> ont tous changé. Ce document remplace tout ce qui précède.

---

## 1. La surface

| Route | Ce qu'elle fait |
|---|---|
| `POST /api/v1/verifications` | Émet un code de vérification et le livre |
| `POST /api/v1/verifications/check` | Vérifie un code présenté |
| `POST /api/v1/messages` | Envoie un message à un utilisateur Alanya |
| `POST /api/v1/media` | Téléverse un fichier et rend son identifiant |

**C'est tout.** `POST /api/v1/messages/send` et `POST /api/v1/calls/initiate`
ont été **supprimées** : la première est remplacée par `POST /api/v1/messages`,
la seconde ne faisait sonner personne et n'aurait servi qu'à le laisser croire.

Tout est gratuit et sans quota de volume. Les seules limites sont des plafonds
de **cadence** (§4).

## 2. Authentification

Une clé API, dans l'un ou l'autre en-tête :

```
X-Api-Key: ak_live_…
Authorization: Bearer ak_live_…
```

La clé n'est montrée **qu'une fois**, à sa création. Nous n'en stockons que
l'empreinte SHA-256 : nous ne pouvons pas vous la relire, seulement en émettre
une nouvelle.

⚠️ Les clés existent en deux types, `ak_test_` et `ak_live_`. **Cette distinction
ne change rien** : il n'y a pas de bac à sable, les deux produisent des effets
réels. Ne fondez aucune logique dessus.

🔴 **Une clé API dans du JavaScript de navigateur est une clé publiée.** Ces
routes sont faites pour être appelées par **votre serveur**.

## 3. Forme des réponses

Succès : la donnée, sans enveloppe. `201` quand la requête crée quelque chose
(un message, un média), `200` sinon.

Erreur : **toujours** cette forme.

```json
{ "error": { "message": "Trop de requêtes. Attendez avant de réessayer.", "code": "RATE_LIMITED" } }
```

`message` s'adresse à l'humain et **peut être reformulé** ; `code` s'adresse au
programme et ne change pas. **Ne jamais brancher sur `message`.**

| `code` | HTTP | Signification |
|---|---|---|
| `API_KEY_MISSING` | 401 | Aucun en-tête d'authentification |
| `API_KEY_INVALID` | 401 | Clé inconnue, désactivée, ou compte absent |
| `INVALID_REQUEST` | 400 | Requête malformée (mauvais format de corps) |
| `VALIDATION` | 422 | Un champ est absent, vide ou hors bornes — voir ci-dessous |
| `RECIPIENT_NOT_FOUND` | 404 | Le numéro ne correspond à aucun compte Alanya |
| `RECIPIENT_BLOCKED` | 403 | Blocage entre l'expéditeur et le destinataire |
| `MEDIA_FORBIDDEN` | 403 | Média inconnu, ou téléversé par une autre clé |
| `MEDIA_TYPE_REJECTED` | 415 | Type de fichier hors liste blanche |
| `MEDIA_TOO_LARGE` | 413 | Fichier au-delà du plafond |
| `RATE_LIMITED` | **429** | Trop de requêtes — attendez, puis réessayez |
| `VERIFICATION_NOT_DELIVERED` | 502 | Le code n'a pas pu être remis |
| `STORAGE_UNAVAILABLE` | 502 | Notre stockage de fichiers n'a pas répondu |
| `INTERNAL_ERROR` | 500 | Défaillance interne |

Un `422 VALIDATION` porte le détail champ par champ :

```json
{ "error": { "message": "Données invalides", "code": "VALIDATION",
             "details": { "fieldErrors": { "destinataire": ["String must contain at least 3 character(s)"] } } } }
```

**Le 429 est le seul refus temporaire.** Attendre puis réessayer est donc
toujours la bonne conduite face à lui, et jamais la bonne face aux autres.

## 4. Plafonds de cadence

| Route | Plafond, **par clé** | Plafond par IP |
|---|---|---|
| `messages` | 60 / min | 120 / min, toutes routes v1 confondues |
| `verifications/check` | 30 / min | idem |
| `media` | 30 / min | idem |
| `verifications` | 20 / min | idem |

Le plafond est **par clé ET par route** : une rafale d'envois ne bloque pas la
2FA du même compte. Un refus porte `HTTP 429`, le code `RATE_LIMITED`, et un
en-tête **`Retry-After` en secondes** — attendez cette durée plutôt que de
deviner.

`POST /api/v1/verifications` porte en plus des plafonds **par destination et par
heure** et **par IP et par heure** : ils protègent la personne qui reçoit les
codes, pas notre infrastructure.

> ⚠️ Ces compteurs vivent en mémoire du processus. Le backend n'en a qu'un
> aujourd'hui, donc le compte est exact ; en grappe, le plafond réel sera plus
> haut, jamais plus bas. Ne dépendez pas d'un refus au 61ᵉ appel précisément.
>
> **Dites-nous vos volumes** (§9) : ce sont des points de départ, pas une
> position de négociation. Rien ne coûte, donc rien n'empêche de les relever.

## 5. Envoyer un message

`POST /api/v1/messages`

```bash
curl -X POST https://alanyavox.com/api/v1/messages \
  -H "X-Api-Key: ak_live_…" \
  -H "Content-Type: application/json" \
  -d '{ "destinataire": "12345678", "type": "TEXT", "texte": "Bonjour" }'
```

| Champ | Obligatoire | Notes |
|---|---|---|
| `destinataire` | oui | Numéro public Alanya **ou** mobile |
| `type` | non | `TEXT` (défaut), `IMAGE`, `VIDEO`, `AUDIO`, `FILE`, `CONTACT`, `LOCATION` |
| `texte` | selon | Le message, ou la légende d'un média. Charge JSON pour `CONTACT` / `LOCATION` |
| `mediaIds` | selon | Jusqu'à 10 identifiants rendus par `POST /api/v1/media` |

Il faut **au moins** un `texte` ou un `mediaIds` non vide : sinon `422`.

```json
{
  "id": "3f9a…-uuid",
  "statut": "ENVOYE",
  "destinataire": "12345678",
  "conversationId": "8c21…-uuid",
  "type": "TEXT",
  "medias": [],
  "envoyeA": "2026-08-21T14:02:11.482Z"
}
```

`id` est **l'identifiant réel du message**, sans préfixe ni enrobage : c'est la
même valeur que celle portée par le webhook.

Trois refus à traiter :

- **404 `RECIPIENT_NOT_FOUND`** — le destinataire doit avoir un compte Alanya.
  Il n'y a pas d'envoi vers un numéro hors plateforme.
- **403 `RECIPIENT_BLOCKED`** — l'un des deux a bloqué l'autre. Ce n'est pas
  passager : cessez de réessayer.
- **403 `MEDIA_FORBIDDEN`** — un `mediaIds` est inconnu, ou a été téléversé par
  une autre clé. Vous ne pouvez joindre que vos propres fichiers.

## 6. Téléverser un fichier

`POST /api/v1/media` — **`multipart/form-data`**, champ `file`.

```bash
curl -X POST https://alanyavox.com/api/v1/media \
  -H "X-Api-Key: ak_live_…" \
  -F "file=@facture.pdf"
```

Champ facultatif : `durationMs`, pour un audio ou une vidéo.

```json
{
  "id": "b7d0…-uuid",
  "url": "/api/media/b7d0…-uuid",
  "nomFichier": "facture.pdf",
  "typeMime": "application/pdf",
  "octets": 48213,
  "dureeMs": null
}
```

Passez ensuite cet `id` dans `mediaIds` de `POST /api/v1/messages`.

⚠️ **Envoyer du JSON ici renvoie `400 INVALID_REQUEST`** : cette route attend un
vrai fichier. Une version antérieure se contentait d'enregistrer une URL que
vous fournissiez — ce n'est plus le cas, et c'est un progrès : le fichier est
désormais chez nous, donc un lien mort chez vous ne casse plus un message chez
nous.

L'`url` rendue est **proxyfiée** (`/api/media/:id`) : c'est elle qui porte le
contrôle d'accès. Ne construisez pas d'URL de stockage vous-même.

## 7. Codes de vérification (OTP et double authentification)

### Émettre

`POST /api/v1/verifications` — `{ finalite, destination, canal? }`

| Champ | Valeurs |
|---|---|
| `finalite` | `AUTH_2FA` · `CREATION_AGENT` · `VALIDATION_CONTACT` |
| `destination` | adresse courriel, ou numéro selon le canal |
| `canal` | `EMAIL` · `ALANYA` — par défaut `EMAIL` pour `AUTH_2FA` |

```json
{ "id": "…", "finalite": "AUTH_2FA", "canal": "EMAIL",
  "destination": "…", "expireA": "2026-08-21T…Z", "livraison": "REMIS" }
```

🔴 **La réponse ne contient JAMAIS le code.** C'est nous qui le livrons. Un canal
« délégué » qui vous aurait rendu le code a été envisagé puis écarté : il
suffisait que votre relais journalise nos réponses pour publier tous les codes.

🔴 **`livraison: "REMIS"` est CONSTATÉ, jamais supposé.** Si rien n'est parti,
vous recevez **502 `VERIFICATION_NOT_DELIVERED`** et non un faux succès. Un seul
code est vivant à la fois par couple (destination, finalité) : en émettre un
nouveau invalide le précédent.

### Vérifier

`POST /api/v1/verifications/check` — `{ finalite, destination, code }`

```json
{ "verifie": false, "essaisRestants": 2 }
```

🔴 **Un refus est un refus, sans motif** — faux, expiré, déjà utilisé ou trop
d'essais rendent la même réponse. Dire « expiré » plutôt que « faux »
apprendrait à un attaquant qu'il visait le bon code ; dire « inconnu »
permettrait d'énumérer vos utilisateurs. Le motif reste dans nos journaux, nous
pouvons le consulter avec vous en cas d'incident.

`essaisRestants` est en revanche rendu : affichez-le, plutôt que de laisser vos
utilisateurs se faire bloquer sans prévenir.

## 8. Webhooks

Configurés depuis le tableau de bord (`POST /api/developer/webhooks`). Nous
appelons votre URL en `POST` :

```json
{
  "evenement": "message.statut",
  "emisA": "2026-08-21T14:02:11.482Z",
  "donnees": {
    "messageId": "3f9a…-uuid",
    "statut": "ENVOYE",
    "destinataire": "12345678"
  }
}
```

`evenement` n'a aujourd'hui qu'une valeur. **Aiguillez quand même dessus** :
c'est ce qui nous permettra d'en ajouter sans casser votre récepteur.

`statut` vaut `ENVOYE`, `REMIS`, `LU` ou `ECHEC`.

### Vérifier la signature

```
X-Alanya-Signature: sha256=<hex>
```

`<hex>` vaut `HMAC-SHA256(corps_brut, secretKey)`. Trois règles :

1. Signez le **corps brut**, les octets reçus — pas un `JSON.parse` suivi d'une
   re-sérialisation, qui changerait l'espacement et donc l'empreinte.
2. Comparez **à temps constant** (`crypto.timingSafeEqual`), jamais par `===`.
3. **Rejetez toute requête non signée.** Si aucun secret n'est configuré, nous
   n'envoyons plus d'en-tête du tout, au lieu d'en envoyer un faux.

Le `secretKey` est tiré par nos soins (32 octets d'aléa) et **rendu une seule
fois**, à l'enregistrement du webhook. `GET /api/developer/webhooks` ne le relit
plus ; il rend `secretKeyDefini: true|false`. Renvoyer un `secretKey` dans un
`POST` le remplace ; ne pas en envoyer conserve celui en place.

## 9. Journal d'activité, et ce qu'il nous faut de vous

Toutes les routes v1 alimentent `GET /api/developer/logs` : endpoint, méthode,
statut et latence de chaque appel, avec `total`, `avgLatencyMs` et
`successRatePercent` calculés sur la période filtrée (pas sur la page). C'est
**votre seule mesure de volume** depuis la disparition des crédits.

Seule exception : une requête refusée **avant** identification (clé absente,
invalide, ou plafond par IP) n'y figure pas — nous ne savons pas à quel compte
l'attribuer.

De votre côté, il nous faut :

1. **Le volume attendu** : messages par jour, et codes de vérification par jour.
   Les plafonds du §4 s'ajustent, mais pas après coup un jour de pointe.
2. **L'IP ou les IP sortantes de votre serveur**, pour vérifier que le plafond
   de 120/min par IP est confortable.
3. ⚠️ **Notre courrier sortant est aujourd'hui plafonné à 500 destinataires par
   jour** (relais Gmail), avec suspension de 24 h au dépassement — incompatible
   avec de la 2FA à volume. Nous basculons sur `no-reply@alanyavox.com` ;
   **donnez-nous votre volume pour que ce soit fait avant votre mise en
   service**, pas après.
4. **Votre URL de webhook**, si vous en voulez un, et confirmation que votre
   récepteur vérifie le HMAC du §8.
5. **Les origines** de votre tableau de bord, si vous appelez depuis un
   navigateur — `Access-Control-Allow-Origin` vaut `*` aujourd'hui et nous
   voulons le restreindre.

*Questions et corrections : elles se traitent dans ce document, versionné avec le
code de l'API.*
