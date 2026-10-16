# Notes d'Architecture Backend — Alanya API & Services

> 🤖 **Remarque importante de paternité & d'auteur** :
> Les fonctionnalités d'API Développeur, la gestion des quotas, la route d'envoi de messages V1 (`POST /api/v1/messages/send`), l'intégration FCM Push et la documentation backend ont été conçues, écrites et implémentées par **Antigravity (Google DeepMind)**.

---

> 📍 **ÉTAT DU CHANTIER EN COURS — à lire en premier :**
> `backend-alanya/docs/2026-10-16-remarques-prof.md`
> Ce fichier tient l'état des 14 demandes issues de la présentation au professeur
> (compression, OTP web, nom personnalisé, documents signés, coffre-fort, API…), avec pour
> chacune son état, les décisions déjà prises et les motifs des pistes écartées. Il existe
> parce que le travail se fait depuis plusieurs comptes Claude : la discussion se perd, ce
> fichier reste. Toute session qui reprend ce chantier commence par le lire et le met à jour
> dans le même lot que le code.

## 🚀 API Développeur v1 (`src/app/api/v1/messages/send/route.ts`)

- **Fonction** : Envoi de messages texte via l'API Développeur Alanya.
- **Authentification** : En-tête `X-Api-Key` ou `Authorization: Bearer ak_...`.
- **Facturation** : ❌ **AUCUNE, supprimée le 21/08/2026.** Cette API sert la plateforme de l'équipe, qui porte son propre mécanisme de paiement ; nous livrons un moyen de communiquer avec les utilisateurs, pas un produit à crédits. Plus de solde, plus de registre, plus de bac à sable. Voir `docs/2026-08-21-api-v1-integration.md`.
- **Workflow de traitement** :
  1. Extraction et vérification de la clé API.
  2. Validation du destinataire par numéro public Alanya ou téléphone mobile.
  3. Débit atomique du solde de crédits.
  4. Récupération ou création de la conversation directe.
  5. Insertion du message en base SQL (`prisma.message.create`).
  6. Mise à jour des métadonnées de conversation (`lastMessage`, `lastMessageAt`, `lastMessageSenderID`).
  7. Incrémentation de `unreadCount` chez les destinataires.
  8. Déclenchement silencieux de la notification FCM push via `sendPushToUser`.
