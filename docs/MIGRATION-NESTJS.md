# Migration backend Next.js → NestJS — Plan d'action

> **Contrainte absolue** : les URLs et les payloads JSON ne changent JAMAIS. Les clients Flutter et STAGE-WEB ne sont pas modifiés, pas recompilés, pas redéployés.
> **Prisma** : réutilisé tel quel. Le `schema.prisma` et les migrations ne sont pas touchés.
> **Analyse réalisée le 16/08/2026** sur `C:/Users/Administrator/Documents/Dev/backend-alanya`.

---

## Contexte — pourquoi ce document

Le backend est aujourd'hui un Next.js 16 App Router utilisé **uniquement comme routeur HTTP** : 101 fichiers `route.ts`, aucune page utile, aucun rendu serveur métier. NestJS apporterait l'injection de dépendances, une structure modulaire testable et un découpage explicite — sans rien changer pour les clients.

Ce fichier existe pour **survivre aux sessions** : il contient l'inventaire complet de l'API, les risques identifiés en lisant le code réel, et le découpage en tickets à me redonner un par un.

---

## 1. État des lieux (constaté, pas supposé)

### 1.1 Ce qui tourne en production

| Process pm2 | Port | Rôle | Périmètre migration |
|---|---|---|---|
| `alanya-api` | 3000 | Next.js — 101 routes API | ✅ **À migrer** |
| `alanya-ws` | 3001 | `ws-server.mjs` (3161 lignes) | ❌ **Hors périmètre** |

Routage nginx (`/etc/nginx/sites-enabled/alanya`) :
- `location /` → `localhost:3000` (Next)
- `location /ws` → `localhost:3001` (WebSocket)
- `location /webapp/` → `alias /home/ubuntu/alanyavox/app/dist/` (client web statique)

Les deux process sont en mode **`fork`, instance unique**. C'est structurant pour la suite (voir risques R3 et R4).

### 1.2 Surface de l'API

**108 handlers sur 101 fichiers** : 46 POST · 37 GET · 15 DELETE · 9 PATCH · 1 PUT.

### 1.3 La bonne nouvelle : aucune dépendance profonde à Next

Vérifié par balayage du code — **zéro occurrence** de :
- `cookies()` — authentification 100% Bearer JWT
- `export const runtime` — pas d'Edge Runtime
- `revalidate` / ISR / cache Next
- `ReadableStream` / streaming SSE
- `after()` / tâches post-réponse

Next ne fournit que : le routeur de fichiers, `NextResponse.json()`, le middleware CORS, et `await params`. **Tout est remplaçable mécaniquement.** C'est le meilleur scénario possible.

### 1.4 Les pages React (tranché : suppression)

| Fichier | Contenu réel | Décision |
|---|---|---|
| `src/app/page.tsx` (66 l.) | **Boilerplate Next par défaut** (« To get started, edit the page.tsx ») | 🗑️ Supprimer |
| `src/app/layout.tsx`, `globals.css`, `page.module.css` | Support du boilerplate | 🗑️ Supprimer |
| `src/app/developer/dashboard/page.tsx` (351 l.) | **Doublon** de la console de STAGE-WEB | 🗑️ Supprimer |

⚠️ **Distinction critique à ne pas rater** : supprimer la *page* console ≠ supprimer l'*API* console.
La vraie console vit dans **STAGE-WEB** (`app/(protected)/developer/developer.tsx`) et appelle en production :
`/api/developer/{keys,logs,webhooks,workspaces,billing/sandbox}` et `/api/v1/{auth/otp/send,auth/otp/verify,media,messages/send}`.
**Ces 9 routes doivent être migrées normalement.** Seules les pages React disparaissent.

Conséquence : une fois ces pages supprimées, `react` et `react-dom` sortent des dépendances et **Next disparaît à 100 %**.

### 1.5 Le noyau `.mjs` partagé — le piège principal

Quatre fichiers en JavaScript brut (et non TS) parce qu'ils sont importés **à la fois** par les routes Next (TS) et par `ws-server.mjs` (Node ESM pur) :

| Fichier | Importé par ws-server | Importé par routes API |
|---|---|---|
| `src/lib/display-name.mjs` | ✅ | **23 routes** |
| `src/lib/ivr.mjs` | ✅ | 4 routes |
| `src/lib/call-labels.mjs` | ✅ | 0 |
| `src/lib/queue-ws.mjs` | ✅ | 0 |

`ws-server.mjs` les importe par **chemin relatif en dur** : `./src/lib/display-name.mjs`.
👉 **Si l'arborescence `src/` bouge, le serveur WebSocket casse** — alors qu'il est hors périmètre. Voir R2.

---

## 2. Inventaire complet des 101 routes

<details>
<summary><b>Arborescence intégrale (à conserver à l'identique)</b></summary>

```
auth/          login · logout · refresh · register · register-dev · setup
               verify · forgot-password · reset-password                    (9)
account/       . · password · privacy · profile                             (4)
me                                                                          (1)
user-access                                                                 (1)
appareils/     . · [appareilId] · nom-agent                                 (3)
contacts/      . · [id]                                                     (2)
blocked/       . · [id]                                                     (2)
users/         [id]/exclude · match · search                                (3)
conversations/ . · direct · [id] · [id]/archive · [id]/calls · [id]/delete
               [id]/disappearing · [id]/leave · [id]/members · [id]/messages
               [id]/messages/[messageId] · [id]/messages/[messageId]/info
               [id]/messages/[messageId]/star · [id]/messages/forward
               [id]/messages/search · [id]/pin · [id]/pin-message
               [id]/pinned · [id]/read                                     (19)
calls/         . · ice · missed · [id]/accept · [id]/delete · [id]/end
               [id]/leave · [id]/reject                                     (8)
queue/         agent-status · callback · history · join · leave · live
               pop · rate                                                   (8)
meetings/      . · [id] · [id]/decline · [id]/delete · [id]/end
               [id]/invite-mode · [id]/invite-requests
               [id]/invite-requests/[reqId] · [id]/join · [id]/leave
               [id]/participants                                           (11)
statuses/      . · [id] · [id]/view · [id]/views                            (4)
media/         . · [id]                                                     (2)
avatars/       [id]                                                         (1)
ai/            chat · messages · threads · threads/[threadId]
               threads/[threadId]/messages                                  (5)
developer/     billing/sandbox · keys · logs · webhooks · workspaces        (5)
v1/            auth/otp/send · auth/otp/verify · calls/initiate
               media · messages/send                                        (5)
geo/           . · consentement                                             (2)
starred · pays · push/register · link-preview · translate
translate/providers                                                         (6)
```
</details>

**Segments dynamiques** : `[id]`, `[appareilId]`, `[messageId]`, `[reqId]`, `[threadId]` → `:id`, `:appareilId`, … (mécanique).

### Routes atypiques (à traiter à part)

| Route | Particularité |
|---|---|
| `POST /api/media` | **Multipart** — seule route à utiliser `formData()` |
| `GET /api/media/[id]` | Renvoie **302 vers URL présignée B2**, ou du **binaire** (`new Response(Uint8Array)`) |
| `GET /api/avatars/[id]` | **302 présigné** |
| `GET /api/contacts`, `/api/users/{search,match}` | Construisent une `Response` brute |
| `POST /api/link-preview` | Fetch HTTP sortant (`redirect: "follow"`) |

---

## 3. Analyse des risques

Classés par gravité réelle. Les risques R1–R4 sont ceux qui **casseront** la migration s'ils sont ignorés.

### 🔴 R1 — Divergence du contrat JSON (le risque n°1)

Le contrat actuel (`src/lib/http.ts`) :
```ts
ok(data, status)   → NextResponse.json(data, {status})        // data à la racine
fail(msg, s, code) → { error: { message, code } }
ZodError           → 422 { error: { message: "Données invalides",
                                    code: "VALIDATION",
                                    details: err.flatten() } }
```

**NestJS viole ce contrat par défaut, sur trois points :**

| Comportement Nest par défaut | Casse |
|---|---|
| `POST` → **201** automatique | Les routes qui renvoient `ok(data)` en **200** changeraient de code |
| `HttpException` → `{statusCode, message, error}` | **Forme d'erreur totalement différente** de `{error:{message,code}}` |
| `ValidationPipe` (class-validator) | Détruit la forme `err.flatten()` de Zod |

**Parades obligatoires, dès le ticket de socle :**
1. `@HttpCode(200)` explicite sur **chaque** POST qui ne renvoie pas 201 — à relever route par route.
2. Un `ExceptionFilter` **global** qui reproduit `{error:{message,code}}` au bit près.
3. **Garder Zod.** Ne pas migrer vers class-validator.
4. **Ne jamais activer `ClassSerializerInterceptor` globalement** — il réécrirait les objets Prisma.

### 🔴 R2 — Casser `ws-server.mjs`, qui est pourtant hors périmètre

`ws-server.mjs` importe `./src/lib/display-name.mjs` **en dur**. Une restructuration NestJS classique (`src/modules/…`, build vers `dist/`) déplacerait ces fichiers → **le serveur WebSocket tombe**, emportant appels, IVR et temps réel.

**Parades :**
- Figer le noyau `.mjs` à un chemin **stable**, non déplacé par le build Nest.
- Ne pas transpiler ces 4 fichiers : Nest les importe tels quels (`allowJs` ou import ESM direct).
- **Test de fumée WebSocket obligatoire** après chaque déploiement, même pour un ticket qui ne touche pas au WS.

### 🔴 R3 — Saturation du pool PostgreSQL pendant la bascule

**Constat mesuré cette semaine : la base était à 106 connexions sur `max_connections = 100`** (saturée par des connexions pgAdmin fantômes).

Faire tourner Next **et** Nest en parallèle = **deux pools Prisma simultanés**. Sur une base déjà à la limite, c'est une panne garantie.

**Parades :**
1. **Avant toute chose** : nettoyer les connexions idle et comprendre le budget réel.
2. Fixer explicitement `connection_limit` dans la `DATABASE_URL` du process Nest (ex. `?connection_limit=5`).
3. Surveiller `pg_stat_activity` à chaque bascule de groupe.

### 🔴 R4 — Rate-limit en mémoire : « split-brain » sur les routes auth

`src/lib/rate-limit.ts` stocke ses compteurs dans une **`Map` en mémoire**, mono-process (le commentaire du fichier le dit : *« En production multi-instances, remplacer par Redis »*).

Si `/api/auth/*` est servi **à la fois** par Next et Nest pendant une bascule progressive, chaque process a ses propres compteurs → **la limite réelle double** (10 tentatives/min au lieu de 5). Faille de sécurité temporaire.

**Parade : `/api/auth/*` bascule en UNE SEULE fois, jamais en partiel.** C'est la raison principale pour laquelle l'auth passe **en dernier**.

### 🟠 R5 — CORS

`src/middleware.ts` : `Access-Control-Allow-Origin: *`, méthodes `GET,POST,PATCH,PUT,DELETE,OPTIONS`, headers `Content-Type, Authorization`, `Max-Age: 86400`, préflight `OPTIONS → 204`.
À répliquer **exactement** via `app.enableCors()`. Une divergence casse le client web (autre origine) sans toucher au mobile — donc **invisible aux tests mobiles**.

### 🟠 R6 — Sérialisation `Date` et `BigInt`

- `Date` : `JSON.stringify` → ISO 8601 des deux côtés. ✅ identique, **tant qu'aucun intercepteur global n'est ajouté**.
- `BigInt` : `JSON.stringify` **lève une exception**. Le code contourne déjà à la main (`l.idHist.toString()` dans `queue/history`). Ces conversions manuelles doivent être **reportées à l'identique** — un oubli produit un 500 en production, pas une erreur de compilation.

### 🟠 R7 — Upload multipart

`POST /api/media` utilise `req.formData()` (API Web standard). Nest/Express passe par **Multer**. À aligner : nom du champ, limite de taille, détection MIME, et **forme exacte de l'erreur** en cas de dépassement.

### 🟡 R8 — Redirections 302 présignées

`media/[id]` et `avatars/[id]` renvoient des `302` vers Backblaze B2. Nest ne doit ni les suivre, ni réécrire l'en-tête `Location`, ni ajouter de `Content-Type`.

### 🟡 R9 — `firebase-admin` en double

Initialisation globale côté Next. En parallèle avec Nest → **double initialisation** de l'app Firebase. À encapsuler dans un provider singleton et à vérifier au démarrage.

### 🟢 R10 — `/api/v1/*` (contrat public)

Mesuré en base : **4 clés, 10 requêtes au total, 0 webhook**. C'est de l'usage de test, **pas de trafic externe réel**. Risque réel faible, malgré le nom « API publique ». À migrer normalement, sans traitement de faveur.

---

## 4. Stratégie « zero downtime » — Strangler Fig piloté par nginx

**Principe** : nginx est l'aiguillage. Nest démarre sur `:3002` à côté de Next `:3000`. On déplace **un groupe de routes à la fois** en ajoutant un `location` nginx. nginx applique le **préfixe le plus long**, donc `location /api/queue/` gagne sur `location /`.

```nginx
location /api/queue/ { proxy_pass http://localhost:3002; }   # migré → Nest
location /           { proxy_pass http://localhost:3000; }   # reste → Next
```

**Rollback = supprimer 1 ligne + `nginx -s reload`.** Aucun redéploiement, aucune recompilation, retour arrière en **moins de 10 secondes**. C'est ce qui rend la migration réversible à chaque étape.

### Déroulé d'une bascule de groupe

1. Implémenter le groupe dans Nest, **sans** l'exposer.
2. Déployer Nest sur `:3002` — invisible, personne ne le route encore.
3. **Diff de contrat** : rejouer les requêtes de référence contre `:3000` et `:3002`, comparer statut + en-têtes + corps (voir §6).
4. `nginx -t && nginx -s reload` avec le nouveau `location`.
5. Observer 15–30 min : logs 4xx/5xx, `pg_stat_activity`, fumée WebSocket.
6. ✅ Stable → groupe suivant. ❌ Anomalie → retirer le `location`, recharger.

### Phases

| Phase | Contenu | Résultat |
|---|---|---|
| **P0 — Socle** | Projet Nest, `PrismaService`, `AuthGuard`, `ZodPipe`, `ExceptionFilter`, CORS, harnais de diff | Nest démarre sur `:3002`, **0 route exposée** |
| **P1 → P5** | Bascule groupe par groupe (§5) | Migration progressive, réversible |
| **P6 — Extinction** | Supprimer les pages React, `react`/`react-dom`/`next` ; nginx `/api/` → `:3002` ; renommer le process pm2 | Next disparaît |
| **P7 — Nettoyage** | Retirer les `location` intermédiaires devenus inutiles | nginx lisible |

⚠️ **Ne jamais éteindre Next avant que les 101 routes soient basculées et stables au moins 48 h.**

---

## 5. Ordre de migration — du plus simple au plus risqué

Critères : lecture seule > écriture · sans effet de bord > avec · faible trafic > cœur produit · sans `.mjs` partagé > avec.

### Palier 0 — Pilote (4 routes) 🟢
`GET /api/pays` · `GET /api/translate/providers` · `GET /api/calls/ice` · `GET /api/queue/agent-status`

Lecture seule, aucun effet de bord, réponses triviales. **But réel : valider le socle** (CORS, forme d'erreur, guard, harnais de diff), pas le métier. Si le contrat dévie ici, il déviera partout.

### Palier 1 — Lecture seule authentifiée (6) 🟢
`me` · `user-access` · `blocked` · `starred` · `appareils` · `contacts`
→ Valide l'`AuthGuard` sur du vrai trafic.

### Palier 2 — CRUD simple, faible trafic (13) 🟢
`account/{.,password,privacy,profile}` · `contacts/[id]` · `blocked/[id]` · `appareils/[appareilId]` · `appareils/nom-agent` · `geo` · `geo/consentement` · `users/{search,match,[id]/exclude}` · `link-preview` · `translate`
→ Premières écritures. Impact limité si régression.

### Palier 3 — Domaines isolés (25) 🟠
`statuses/*` (4) · `developer/*` (5) · `ai/*` (5) · `meetings/*` (11)
→ Volumineux mais **cloisonnés**. ⚠️ `developer/*` est consommé par la console STAGE-WEB — à tester **sur le web**, pas seulement sur mobile.

### Palier 4 — Cœur produit (36) 🔴
`conversations/*` (19) · `calls/*` (8) · `queue/*` (8) · `push/register`
→ Gros volume, **noyau `.mjs` partagé** (`display-name`, `ivr`, `call-labels`), couplage fort au `ws-server`.
**Un groupe à la fois** : `conversations`, puis `calls`, puis `queue`. Fumée WebSocket **systématique**.

### Palier 5 — Les plus risqués (14) 🔴

1. `media` · `media/[id]` · `avatars/[id]` → multipart + binaire + 302 présigné (R7, R8). Dégradation *visible mais non bloquante* : les images cassent, l'app fonctionne.
2. `v1/*` (5) → contrat public, mais usage test (R10).
3. **`auth/*` (9) — EN DERNIER, en une seule bascule atomique.**

> **Pourquoi l'auth en dernier** : une régression y déconnecte **100 % des utilisateurs instantanément** (les deux clients, mobile et web). Et le rate-limit en mémoire (R4) **interdit** toute bascule partielle. C'est la seule étape où je recommande une fenêtre de faible trafic et une surveillance active.

---

## 6. Technos NestJS — choix et justifications

Principe directeur : **le choix le moins divergent gagne**. Chaque brique « moderne » adoptée est une occasion de casser le contrat.

| Besoin | Choix | Pourquoi (et ce qu'on écarte) |
|---|---|---|
| **Plateforme HTTP** | `@nestjs/platform-express` | ❌ Pas Fastify : écosystème Multer mature, sérialisation identique à l'existant, moins de divergence. La perf n'est pas le sujet. |
| **Auth** | **Guard custom réutilisant `src/lib/jwt.ts`** | ❌ Pas `@nestjs/passport` : le code de vérification existe et est éprouvé. Passport ajoute une couche qui change la forme des erreurs 401. On réutilise `verifyAccessToken` tel quel → **zéro dérive**. |
| **Validation** | **Zod conservé**, via un `ZodValidationPipe` custom | ❌ Pas class-validator : changerait la forme `err.flatten()` du 422 (R1). Les schémas de `src/lib/validation.ts` sont réutilisés **sans réécriture**. |
| **Config** | `@nestjs/config` | En gardant la sémantique *fail-fast* de `src/lib/env.ts` (throw au démarrage si variable critique absente). |
| **Base de données** | `PrismaService extends PrismaClient` + `onModuleInit`/`onModuleDestroy` | Même client généré, **même `schema.prisma`, aucune migration**. ⚠️ `connection_limit` explicite (R3). |
| **Upload** | Multer `memoryStorage` via `@nestjs/platform-express` | Correspond au flux actuel : `formData` → `Buffer` → B2. Pas de fichier temporaire sur disque. |
| **WebSocket** | **AUCUNE — hors périmètre** | `ws-server.mjs` reste tel quel sous pm2. Il ne dépend pas de Next. Le migrer réécrirait la signalisation WebRTC + IVR : le code le plus fragile, pour zéro gain. |
| **Queue / jobs** | **AUCUNE — ne rien introduire** | ⚠️ Piège de vocabulaire : `/api/queue/*` est la **file d'attente métier de l'IVR**, stockée en base — **pas** une file de jobs. Il n'existe aujourd'hui **aucun job asynchrone**. Introduire BullMQ + Redis serait de la complexité pure. |
| **Push** | `firebase-admin` en provider singleton | Encapsule l'initialisation globale actuelle (R9). |
| **Rate-limit** | **Garder l'implémentation mémoire** dans un provider | ❌ Pas `@nestjs/throttler` : changerait la forme du 429 et les clés. Redis **seulement** si passage multi-instances un jour — décision séparée, pas dans cette migration. |
| **Logs** | Logger Nest par défaut | Suffisant. pm2 capture déjà stdout. |

---

## 7. Checklist de non-régression

### 7.1 Le filet principal — harnais de diff de contrat

**C'est l'outil qui rend la migration sûre.** Sans lui, on valide à l'œil et on rate les divergences silencieuses.

1. **Capturer** un jeu de requêtes de référence (méthode, URL, en-têtes, corps) couvrant les 101 routes — cas nominal, cas 401, cas 404, cas validation invalide.
2. **Rejouer** chaque requête contre `:3000` (Next) **et** `:3002` (Nest), avec le même jeton.
3. **Comparer** : code HTTP · en-têtes significatifs (`Content-Type`, `Location`, CORS) · **corps JSON normalisé** (tri des clés ; masquage des champs volatils : `id` générés, `createdAt`, jetons).
4. **Toute différence = bloquant**, sauf justification écrite.

### 7.2 Points de contrôle par route

- [ ] Code HTTP **identique** (⚠️ POST 200 vs 201 — R1)
- [ ] Corps **strictement identique** (ordre des clés indifférent, présence/absence non)
- [ ] Champs **absents** absents (ne pas ajouter de `null` là où la clé n'existait pas)
- [ ] Dates en **ISO 8601**, `BigInt` en **chaîne**
- [ ] 401 sans jeton / jeton expiré → `{error:{message,code:"UNAUTHORIZED"}}`
- [ ] 422 validation → `details` au format `zod.flatten()`
- [ ] 404 sur ressource inexistante → même forme
- [ ] En-têtes CORS présents, `OPTIONS` → **204**

### 7.3 Fumée fonctionnelle — sur les DEUX clients

⚠️ Le mobile et le web n'exercent pas les mêmes chemins. Le web est le seul à utiliser la console développeur et le CORS.

**Mobile (Flutter)** : connexion · liste conversations · envoi texte · envoi image (upload) · affichage avatars · appel audio A→B · appel via IVR (menu + file) · statuts · réunion.

**Web (STAGE-WEB)** : *idem* + **console développeur** (clés, logs, webhooks, workspaces) + vérification CORS (aucune erreur d'origine en console navigateur).

### 7.4 Non-régression WebSocket (après CHAQUE bascule)

Même pour un groupe sans rapport — `ws-server` partage le noyau `.mjs` (R2).
- [ ] `alanya-ws` en ligne, sans redémarrage intempestif (`pm2 list` : compteur `↺` stable)
- [ ] Un appel sonne réellement sur un appareil
- [ ] Le menu IVR s'affiche et une touche route vers un agent
- [ ] Un message temps réel arrive sans rechargement

### 7.5 Santé infrastructure

- [ ] `pg_stat_activity` : total **< 80** connexions (R3)
- [ ] Pas de fuite mémoire sur `:3002` après 1 h
- [ ] Logs sans 5xx nouveaux

---

## 8. Découpage en tickets

À me redonner **un par un**. Chaque ticket est autonome, testable, et réversible.

### Socle

| # | Ticket | Livrable | Bloquant pour |
|---|---|---|---|
| **T0** | **Assainir les connexions PostgreSQL** | Base sous 80/100, cause des connexions fantômes comprise | ⚠️ **TOUT** (R3) |
| **T1** | Projet Nest + `PrismaService` | Nest démarre sur `:3002`, `/health` répond, pool limité | T2+ |
| **T2** | Socle contrat : `ExceptionFilter` + `ZodPipe` + CORS + `AuthGuard` | Formes d'erreur **identiques** à Next, Zod réutilisé | T4+ |
| **T3** | Harnais de diff de contrat | Script rejouant N requêtes sur `:3000` et `:3002` + rapport de diff | Toutes les bascules |

### Bascules progressives

| # | Ticket | Routes | Risque |
|---|---|---|---|
| **T4** | Palier 0 — pilote | 4 | 🟢 |
| **T5** | Palier 1 — lecture seule | 6 | 🟢 |
| **T6** | Palier 2 — CRUD simple | 13 | 🟢 |
| **T7** | `statuses/*` | 4 | 🟠 |
| **T8** | `developer/*` | 5 | 🟠 tester **sur le web** |
| **T9** | `ai/*` | 5 | 🟠 dépend Gemini |
| **T10** | `meetings/*` | 11 | 🟠 |
| **T11** | `conversations/*` | 19 | 🔴 `.mjs` partagé |
| **T12** | `calls/*` | 8 | 🔴 couplé ws-server |
| **T13** | `queue/*` | 8 | 🔴 couplé IVR |
| **T14** | `push/register` | 1 | 🔴 firebase (R9) |
| **T15** | `media`, `avatars` | 3 | 🔴 multipart + 302 |
| **T16** | `v1/*` | 5 | 🟠 |
| **T17** | **`auth/*` — bascule atomique** | 9 | 🔴🔴 **le plus risqué** |

### Extinction

| # | Ticket | Contenu |
|---|---|---|
| **T18** | Supprimer les pages React | `page.tsx`, `layout.tsx`, `developer/dashboard/`, CSS ; retirer `react`, `react-dom`, `next` |
| **T19** | Bascule nginx finale + pm2 | `/api/` → `:3002` en une règle ; process renommé ; `pm2 save` |
| **T20** | Nettoyage | Retirer les `location` intermédiaires ; documenter l'architecture finale |

**Chemin critique** : T0 → T1 → T2 → T3 → *(T4…T17 dans l'ordre)* → T18 → T19 → T20.

---

## 9. Ce que je recommande de faire en premier

1. **T0 — la base de données.** Elle était à 106/100 connexions. Tant que ce n'est pas assaini, faire tourner un second process Prisma provoquera une panne. Ce n'est pas de la migration, c'est un prérequis.
2. **T1 → T3 d'affilée** : sans le harnais de diff (T3), aucune bascule n'est vérifiable autrement qu'à l'œil.
3. **T4 (pilote)** pour valider le socle sur 4 routes inoffensives avant d'engager quoi que ce soit de sérieux.

---

## 10. Vérification de fin de migration

- [ ] Les 101 routes répondent via Nest, diff de contrat **vide**
- [ ] `next`, `react`, `react-dom` absents du `package.json`
- [ ] `alanya-ws` jamais redémarré à cause de la migration (`↺` inchangé)
- [ ] Mobile **et** web fonctionnent **sans avoir été recompilés** ← la preuve que la contrainte est tenue
- [ ] `schema.prisma` **identique** à son état du 16/08/2026 (`git diff` vide)
- [ ] Connexions PostgreSQL stables sous 80
