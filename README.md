# 🏠 Alanya — Backend API -- BRIA GROUP

> API backend pour l'application Alanya : messagerie temps réel, appels audio/vidéo, stories éphémères et assistant IA.

---

## ⚡ Stack technique

| Technologie | Version | Usage |
|---|---|---|
| **Next.js** | 16.2.7 | Framework principal (App Router) |
| **TypeScript** | 5 | Typage statique |
| **Prisma** | 6.1.0 | ORM + migrations PostgreSQL |
| **PostgreSQL** | — | Base de données relationnelle |
| **JWT** | 9.0.2 | Authentification par tokens |
| **Firebase Admin** | 13.0.2 | Push notifications (FCM) |
| **Gemini (Google)** | — | Assistant conversationnel IA |
| **Nodemailer** | 6.9.16 | Envoi d'emails (OTP) |
| **Zod** | 3.24.1 | Validation des données |
| **bcryptjs** | 2.4.3 | Hachage des mots de passe |
| **ws** | 8.21.0 | WebSockets (serveur séparé) |

---

## 📁 Structure du projet

```
backend-alanya/
├── prisma/
│   ├── migrations/         # Migrations de base de données
│   └── schema.prisma       # Schéma complet du modèle de données
├── src/
│   ├── app/                # Routes API Next.js (App Router)
│   │   └── api/
│   │       ├── account/profile/   # Gestion du profil utilisateur
│   │       ├── ai/                # Endpoints IA (Gemini)
│   │       ├── auth/              # Inscription, login, logout, refresh
│   │       ├── calls/             # Appels audio / vidéo
│   │       ├── contacts/          # Gestion des contacts
│   │       ├── conversations/     # Messagerie (1:1 et groupe)
│   │       ├── me/                # Profil de l'utilisateur connecté
│   │       ├── media/             # Upload, téléchargement de médias
│   │       ├── push/register/     # Enregistrement FCM
│   │       ├── statuses/          # Stories / statuts éphémères
│   │       └── users/             # Recherche et gestion des utilisateurs
│   ├── lib/                 # Utilitaires et services réutilisables
│   │   ├── auth-context.ts  # Contexte d'authentification
│   │   ├── calls.ts         # Logique des appels
│   │   ├── env.ts           # Variables d'environnement typées
│   │   ├── firebase.ts      # Initialisation Firebase Admin
│   │   ├── gemini.ts        # Client Gemini IA
│   │   ├── http.ts          # Utilitaires HTTP
│   │   ├── jwt.ts           # Création/vérification JWT
│   │   ├── mailer.ts        # Envoi d'emails (Nodemailer)
│   │   ├── otp.ts           # Génération et vérification OTP
│   │   ├── password.ts      # Hachage/vérification mot de passe
│   │   ├── prisma.ts        # Instance Prisma Client (singleton)
│   │   ├── publicNumber.ts  # Génération numéro public 6 chiffres
│   │   ├── push.ts          # Envoi de notifications push
│   │   ├── rate-limit.ts    # Middleware de limitation de débit
│   │   └── validation.ts    # Schémas Zod partagés
│   ├── modules/
│   │   └── auth/
│   │       └── tokens.ts    # Gestion avancée des tokens refresh
│   └── middleware.ts        # Middleware CORS pour Flutter Web
├── scripts/                 # Scripts utilitaires (migration, seed, etc.)
├── storage/                 # Stockage local des fichiers médias
├── public/                  # Fichiers statiques publics
├── next.config.ts           # Configuration Next.js + headers CORS
├── render.yaml              # Configuration de déploiement Render
├── ws-server.mjs            # Serveur WebSocket autonome
├── push.mjs                 # Script d'envoi de notifications push
└── requests.http            # Tests HTTP (VS Code REST Client)
```

---

## 🚀 Installation et démarrage

### Prérequis

- **Node.js** 20+
- **PostgreSQL** (base de données)
- Variables d'environnement configurées (voir `.env`)

### Étapes

```bash
# 1. Cloner le dépôt
git clone https://github.com/Dominique-BRIA/backend-alanya.git
cd backend-alanya

# 2. Installer les dépendances
npm install

# 3. Configurer les variables d'environnement
cp .env.example .env
# Éditer .env avec vos valeurs (DATABASE_URL, JWT_SECRET, etc.)

# 4. Générer le client Prisma
npm run prisma:generate

# 5. Appliquer les migrations
npm run prisma:migrate

# 6. Lancer le serveur de développement
npm run dev

# 7. (Optionnel) Lancer le serveur WebSocket en local
npm run ws-local
```

Le serveur de dev sera accessible sur [http://localhost:3000](http://localhost:3000).

---

## 🔑 Variables d'environnement

```env
# Base de données PostgreSQL
DATABASE_URL="postgresql://user:password@host:5432/alanya"

# JWT
JWT_SECRET="votre-secret-super-securise"
JWT_EXPIRES_IN="7d"

# Firebase (Admin SDK)
FIREBASE_PROJECT_ID="votre-projet-firebase"
FIREBASE_PRIVATE_KEY="..."
FIREBASE_CLIENT_EMAIL="..."

# Google Gemini
GEMINI_API_KEY="..."

# Email (SMTP)
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_USER="..."
SMTP_PASS="..."
SMTP_FROM="Alanya <noreply@alanya.app>"

# CORS
ALLOWED_ORIGINS="http://localhost:3000,https://votre-app.web.app"
```

> **Note** : `FIREBASE_PRIVATE_KEY` doit avoir ses `\n` échappés en `\\n` dans la variable d'environnement.

---

## 🌐 API — Endpoints principaux

### Authentification

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/register` | Inscription (email, mot de passe) |
| POST | `/api/auth/login` | Connexion |
| POST | `/api/auth/logout` | Déconnexion (révocation du refresh token) |
| POST | `/api/auth/refresh` | Rafraîchir l'access token |
| POST | `/api/auth/verify-email` | Vérifier le code OTP email |
| POST | `/api/auth/forgot-password` | Demande de réinitialisation |
| POST | `/api/auth/reset-password` | Réinitialiser le mot de passe |

### Utilisateur

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/me` | Profil de l'utilisateur connecté |
| PATCH | `/api/me` | Modifier son profil |
| GET | `/api/users/search?q=` | Rechercher des utilisateurs |
| GET | `/api/users/:id` | Détails d'un utilisateur |

### Contacts

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/contacts` | Liste des contacts |
| POST | `/api/contacts` | Ajouter un contact |
| PATCH | `/api/contacts/:id` | Modifier (alias, blocage) |
| DELETE | `/api/contacts/:id` | Supprimer un contact |

### Conversations & Messages

| Méthode | Route | Description |
|---|---|---|
| GET | `/api/conversations` | Liste des conversations |
| POST | `/api/conversations` | Créer conversation (1:1 ou groupe) |
| GET | `/api/conversations/:id/messages` | Messages d'une conversation |
| POST | `/api/conversations/:id/messages` | Envoyer un message |

### Stories / Statuts

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/statuses` | Publier un statut (ephémère) |
| GET | `/api/statuses` | Liste des stories disponibles |
| POST | `/api/statuses/:id/view` | Marquer comme vu |

### Appels

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/calls/initiate` | Initier un appel |
| POST | `/api/calls/:id/accept` | Accepter un appel |
| POST | `/api/calls/:id/reject` | Rejeter un appel |
| POST | `/api/calls/:id/end` | Terminer un appel |

### Médias

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/media/upload` | Uploader un fichier |
| GET | `/api/media/:id` | Télécharger un média |
| DELETE | `/api/media/:id` | Supprimer un média |

### IA (Gemini)

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/ai/chat` | Envoyer un message à l'assistant IA |
| GET | `/api/ai/threads` | Liste des conversations IA |
| DELETE | `/api/ai/threads/:id` | Supprimer un thread |

### Push Notifications

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/push/register` | Enregistrer un token FCM |

---

## 🗄️ Modèle de données

### Entités principales

```
User
├── Profile              # Pseudo, avatar, message de statut
├── RefreshToken         # Tokens de session
├── PushDevice           # Tokens FCM (multi-appareils)
├── EmailVerification    # Codes OTP
├── Contact              # Relations avec d'autres utilisateurs
├── Conversation         # Conversations dont il fait partie
├── Message              # Messages envoyés
├── Status               # Stories publiées
├── StatusView           # Views sur les stories
├── Call / CallParticipant # Appels
├── AiThread             # Threads de conversation IA
└── MediaFile            # Médias uploadés

Conversation
├── Participant          # Participants (1:1 ou groupe)
└── Message              # Messages échangés

Status
└── StatusView           # Qui a vu quelle story
```

### Conventions adoptées

- ✅ Clés primaires en **UUID**
- ✅ Dates en **TIMESTAMPTZ** (timezone-aware)
- ✅ Mots de passe **hashés BCrypt**
- ✅ Index sur colonnes fréquemment filtrées (`publicNumber`, `email`, `userId`)
- ✅ Numéros publics **uniques à 6 chiffres** pour l'identification

---

## 🔒 Sécurité

| Mécanisme | Implémentation |
|---|---|
| **Authentification** | JWT avec access token + refresh token |
| **Mots de passe** | BCrypt (coût 12) |
| **OTP** | Codes 6 chiffres hashés (non stockés en clair) |
| **Rate limiting** | Middleware configurable par endpoint |
| **Validation** | Schémas Zod sur toutes les entrées |
| **CORS** | Configuré pour l'application Flutter Web |
| **Middleware Next.js** | Headers CORS appliqués à toutes les routes `/api/*` |

> ⚠️ En production, remplacez `Access-Control-Allow-Origin: *` par l'origine de votre application.

---

## ☁️ Déploiement

### Render (recommandé)

```bash
# Le fichier render.yaml configure automatiquement :
# - Build command : npm run vercel-build
# - Start command : npm start
```

Déployez via le dashboard Render ou connectez votre repo GitHub.

### Vercel

```bash
# Le script "vercel-build" dans package.json lance :
# prisma migrate deploy && next build
```

### Variables d'environnement à configurer

```
DATABASE_URL
JWT_SECRET
FIREBASE_PROJECT_ID
FIREBASE_PRIVATE_KEY
FIREBASE_CLIENT_EMAIL
GEMINI_API_KEY
SMTP_HOST / SMTP_USER / SMTP_PASS / SMTP_FROM
```

---

## 🧪 Tests manuels

Le fichier `requests.http` (compatible VS Code REST Client) contient des exemples de requêtes pour tester les endpoints :

```http
### Login
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{ "email": "test@example.com", "password": "..." }
```

---

## 🛠️ Scripts disponibles

```bash
npm run dev                 # Développement (Next.js)
npm run ws-local            # WebSocket en local
npm run build               # Build de production
npm run start               # Démarrer en production
npm run lint                # Linting ESLint
npm run prisma:generate     # Générer le client Prisma
npm run prisma:migrate      # Appliquer les migrations (dev)
npm run prisma:migrate:deploy # Appliquer les migrations (prod)
npm run prisma:studio       # Interface graphique Prisma
```

---

## 🚧 Axes d'amélioration

- [ ] Ajouter un framework de tests (Jest / Vitest)
- [ ] Documenter les erreurs et codes de réponse
- [ ] Implémenter le versioning de l'API (`/api/v1/`)
- [ ] Ajouter des tests de charge (k6, Artillery)
- [ ] Configurer un système de monitoring (Sentry, DataDog)
- [ ] Ajouter des logs structurés
- [ ] Implémenter le filtrage anti-spam / détection de contenu

---

## 📄 Licence

Projet privé — Dominique BRIA © 2026
