 # Harmonisation base de données Alanya — Plan & Mapping

**Objectif** : aligner la base Neon (PostgreSQL) de ce membre sur le schéma de référence
de l'équipe (`alanya.sql`, MySQL), pour la **cohérence structurelle et sémantique**.

## Décisions validées
- **Clés primaires** : on garde **UUID** (autorisé — l'équipe n'impose pas les types SQL).
- **Nommage** : on colle au référentiel **tel quel** (même incohérent : `alanyaID`, `msgID`, `conversID`…).
- **Périmètre** : renommer/aligner les tables communes, **ajouter** les manquantes si utile,
  **garder** les tables en plus (IA Gemini, médias, auth, appels de groupe). Rien n'est supprimé.

## Principe clé (ce qui rend l'opération sûre)
Le backend mappe chaque ligne Prisma vers des littéraux JSON **écrits à la main**, et tout le
code (routes API + `ws-server.mjs` + `push.mjs`) utilise les **noms de champ Prisma**, jamais
les noms de colonnes SQL. Donc renommer les colonnes/tables physiques via `@map`/`@@map` est
**transparent pour le code et pour le frontend Flutter** : le contrat JSON (`id`, `publicNumber`,
`convId`, `senderId`…) reste identique.

➡️ **On renomme uniquement les identifiants physiques Postgres. Aucun changement de code
applicatif, aucun changement frontend, aucune rupture du contrat API.**

## État actuel (introspection prod, 20 tables)
Déjà conformes au référentiel (aucune action) : `pays`, `meeting`, `participant`, `blocked`,
et les champs `users` en snake_case (`type_compte`, `avatar_url`, `last_seen`, `is_online`…).

Extras conservés tels quels : `media_files`, `ai_threads`, `ai_messages`, `push_devices`,
`refresh_tokens`, `email_verifications`, `message_hides`, `calls`, `call_participants`.

## Mapping des renommages (Phase 1 — cœur de l'harmonisation)

### Table `users` (nom de table inchangé)
| Colonne actuelle | Colonne cible (réf.) | Note |
|---|---|---|
| `id` | `alanyaID` | PK, reste UUID |
| `passwordHash` | `password` | |
| `publicNumber` | `alanyaPhone` | reste VARCHAR(8), unique |
| `createdAt` | `created_at` | |
| `emailVerified`, `updatedAt`, `status_msg` | *(inchangés — extras)* | absents du réf. |

### `contacts` → **`preferredContact`**
| `id`→`idPrefContact` · `userId`→`alanyaID` · `contactId`→`idFriend` · `createdAt`→`created_at` · `alias`,`isBlocked` extras |

### `conversations` → **`conversation`**
| `id`→`conversID` · `name`→`GroupName` · `avatarUrl`→`groupPhoto` · `createdAt`,`updatedAt` extras · `lastMessage*`,`isGroup` déjà OK |

### `participants` → **`conv_participants`**
| `convId`→`conversID` · `userId`→`alanyaID` · `id`,`joinedAt`,`isPinned`,`isArchived`,`unreadCount` OK · `role`,`lastReadAt` extras |

### `messages` → **`message`**
| `id`→`msgID` · `convId`→`conversationID` · `senderId`→`senderID` · `replyToId`→`replyToID` · `createdAt`→`sendAt` · `deletedAt` extra |

### `statuses` → **`statut`**
| `id`→`ID` · `userId`→`alanyaID` · `bgColor`→`backgroundColor` · `expiresAt`→`expiredAt` |

### `status_views` → **`statut_views`**
| `statusId`→`statutID` · `viewerId`→`alanyaID` · `viewedAt`→`seenAt` |

## Phase 2 — Ajouts (optionnels, à confirmer)
Tables du référentiel absentes ici :
- `userAccess` (journal de connexions) — feature non implémentée localement.
- `reserved_alanya_phone` (numéros réservés admin) — feature non implémentée.
- `callHistory` — **doublon** de nos `calls`/`call_participants` (modèle plus riche, gère les
  appels de groupe). Recommandation : **ne pas ajouter** (nos `calls` en sont l'équivalent).

Colonnes `users` du référentiel absentes ici (`exclude_at`, `exclude_reason`, `in_call`,
`biometric`, `fcm_token`, `device_ID`, `reset_otp`, `reset_otp_expires_at`) : correspondent à
des features gérées autrement chez nous (OTP via `email_verifications`, tokens FCM via
`push_devices`). Recommandation : **ne pas ajouter de colonnes inutilisées** (bruit).

## Exécution — TERMINÉE (2026-07-24)
1. ✅ **Branches de sauvegarde** poussées : `backup/pre-harmonisation-2026-07-24` sur
   `backend-alanya` et sur `alanya` (frontend). État pré-harmonisation entièrement restaurable.
2. ✅ `schema.prisma` édité : `@@map`/`@map` ajoutés, noms de champ Prisma inchangés.
3. ⚠️ **Réconciliation du journal de migrations** : la prod avait dérivé (`prisma db push`)
   par rapport à `prisma/migrations/` (2 migrations non enregistrées mais déjà appliquées).
   Résolu via `prisma migrate resolve --applied` avant de continuer, sinon le déploiement
   aurait échoué sur un `CREATE TABLE` en doublon.
4. ✅ Migration `20260724120000_harmonisation_referentiel` écrite à la main
   (`ALTER TABLE … RENAME`, jamais de drop/create) et **appliquée en production Neon**
   via `prisma migrate deploy`.
5. ✅ **Vérification post-migration** :
   - Ré-introspection : 23 modèles (20 + 3 nouvelles tables), tous les noms de table
     correspondent au référentiel (`preferredContact`, `conversation`, `conv_participants`,
     `message`, `statut`, `statut_views`, `userAccess`, `callHistory`, `reserved_alanya_phone`).
   - **Aucune perte de données** : comptages identiques avant/après (41 users, 55 conversations,
     128 participants, 1195 messages, 83 contacts, 29 statuts, 35 vues, 10 meetings, 25 pays).
   - `tsc --noEmit` : 0 erreur. `npm run build` : succès, toutes les routes compilées.
   - `ws-server.mjs` / `push.mjs` (non typés) : vérifiés syntaxiquement, non modifiés (ils
     utilisent les noms de champ Prisma, jamais les noms de colonnes SQL).
   - Smoke test HTTP en direct contre la prod : `/api/pays` (401 correct sans token),
     `/api/auth/login` (chemin `password`/`alanyaPhone` exercé, réponse propre).
6. ✅ Frontend : **aucun changement** — contrat JSON identique confirmé (git status vide).
7. ✅ Commit + push sur `test-clean` (backend) : `11bb6c7`.

## Ce qui reste (hors périmètre de cette session, à décider ensuite)
- Les nouvelles tables (`userAccess`, `callHistory`, `reserved_alanya_phone`) sont créées
  **vides** ; aucune route API ne les alimente encore. À brancher si l'équipe veut les
  utiliser (journal de connexions, historique d'appels 1-à-1, numéros réservés).
- Les nouvelles colonnes `users` (`fcm_token`, `device_ID`, `reset_otp`, …) sont ajoutées
  avec des valeurs par défaut mais ne sont pas encore lues/écrites par le code — actuellement
  ces features passent par d'autres tables (`push_devices`, `email_verifications`).
