-- Harmonisation des noms de tables/colonnes sur le référentiel équipe (alanya.sql).
-- Renommages uniquement : AUCUNE donnée n'est supprimée ou recréée.
-- Les types restent inchangés (UUID conservés — décision validée : pas de conformité
-- stricte aux types SQL, seulement à la structure/nommage).
--
-- IMPORTANT : Postgres propage automatiquement les renommages de colonnes/tables aux
-- contraintes de clé étrangère, index et vues dépendantes (suivi par OID interne),
-- donc aucune contrainte n'a besoin d'être recréée.

-- =============================================================
-- 1. USERS (table inchangée, colonnes alignées)
-- =============================================================
ALTER TABLE "users" RENAME COLUMN "id" TO "alanyaID";
ALTER TABLE "users" RENAME COLUMN "passwordHash" TO "password";
ALTER TABLE "users" RENAME COLUMN "publicNumber" TO "alanyaPhone";
ALTER TABLE "users" RENAME COLUMN "createdAt" TO "created_at";

ALTER TABLE "users"
  ADD COLUMN "exclude_at" TIMESTAMPTZ(6),
  ADD COLUMN "exclude_reason" VARCHAR(255),
  ADD COLUMN "in_call" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "biometric" SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "fcm_token" VARCHAR(255),
  ADD COLUMN "device_ID" VARCHAR(255),
  ADD COLUMN "reset_otp" VARCHAR(6),
  ADD COLUMN "reset_otp_expires_at" TIMESTAMPTZ(6);

-- =============================================================
-- 2. CONTACTS -> preferredContact
-- =============================================================
ALTER TABLE "contacts" RENAME TO "preferredContact";
ALTER TABLE "preferredContact" RENAME COLUMN "id" TO "idPrefContact";
ALTER TABLE "preferredContact" RENAME COLUMN "userId" TO "alanyaID";
ALTER TABLE "preferredContact" RENAME COLUMN "contactId" TO "idFriend";
ALTER TABLE "preferredContact" RENAME COLUMN "createdAt" TO "created_at";

-- =============================================================
-- 3. CONVERSATIONS -> conversation
-- =============================================================
ALTER TABLE "conversations" RENAME TO "conversation";
ALTER TABLE "conversation" RENAME COLUMN "id" TO "conversID";
ALTER TABLE "conversation" RENAME COLUMN "name" TO "GroupName";
ALTER TABLE "conversation" RENAME COLUMN "avatarUrl" TO "groupPhoto";

-- =============================================================
-- 4. PARTICIPANTS -> conv_participants
-- =============================================================
ALTER TABLE "participants" RENAME TO "conv_participants";
ALTER TABLE "conv_participants" RENAME COLUMN "convId" TO "conversID";
ALTER TABLE "conv_participants" RENAME COLUMN "userId" TO "alanyaID";

-- =============================================================
-- 5. MESSAGES -> message
-- =============================================================
ALTER TABLE "messages" RENAME TO "message";
ALTER TABLE "message" RENAME COLUMN "id" TO "msgID";
ALTER TABLE "message" RENAME COLUMN "convId" TO "conversationID";
ALTER TABLE "message" RENAME COLUMN "senderId" TO "senderID";
ALTER TABLE "message" RENAME COLUMN "replyToId" TO "replyToID";
ALTER TABLE "message" RENAME COLUMN "createdAt" TO "sendAt";

-- =============================================================
-- 6. STATUSES -> statut
-- =============================================================
ALTER TABLE "statuses" RENAME TO "statut";
ALTER TABLE "statut" RENAME COLUMN "id" TO "ID";
ALTER TABLE "statut" RENAME COLUMN "userId" TO "alanyaID";
ALTER TABLE "statut" RENAME COLUMN "bgColor" TO "backgroundColor";
ALTER TABLE "statut" RENAME COLUMN "expiresAt" TO "expiredAt";

-- =============================================================
-- 7. STATUS_VIEWS -> statut_views
-- =============================================================
ALTER TABLE "status_views" RENAME TO "statut_views";
ALTER TABLE "statut_views" RENAME COLUMN "statusId" TO "statutID";
ALTER TABLE "statut_views" RENAME COLUMN "viewerId" TO "alanyaID";
ALTER TABLE "statut_views" RENAME COLUMN "viewedAt" TO "seenAt";

-- =============================================================
-- 8. USER_ACCESS (nouvelle table du référentiel)
-- =============================================================
CREATE TABLE "userAccess" (
  "idLogin"   BIGSERIAL PRIMARY KEY,
  "alanyaID"  UUID NOT NULL,
  "device"    VARCHAR(255) NOT NULL DEFAULT 'INDEFINI',
  "dateLogin" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "ipAdress"  VARCHAR(255) NOT NULL DEFAULT 'INDEFINI',
  "os_system" VARCHAR(255) NOT NULL DEFAULT 'INDEFINI',
  CONSTRAINT "userAccess_alanyaID_fkey" FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID") ON DELETE CASCADE
);
CREATE INDEX "userAccess_dateLogin_idx" ON "userAccess"("dateLogin");

-- =============================================================
-- 9. CALL_HISTORY (nouvelle table du référentiel — complète nos `calls` de groupe)
-- =============================================================
CREATE TABLE "callHistory" (
  "IDcall"     BIGSERIAL PRIMARY KEY,
  "idCaller"   UUID NOT NULL,
  "idReceiver" UUID NOT NULL,
  "type"       SMALLINT NOT NULL DEFAULT 0,
  "status"     SMALLINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "start_time" TIMESTAMPTZ(6),
  "duree"      INTEGER NOT NULL DEFAULT 0,
  "mode"       SMALLINT,
  "ip"         VARCHAR(45),
  CONSTRAINT "callHistory_idCaller_fkey" FOREIGN KEY ("idCaller") REFERENCES "users"("alanyaID") ON DELETE CASCADE,
  CONSTRAINT "callHistory_idReceiver_fkey" FOREIGN KEY ("idReceiver") REFERENCES "users"("alanyaID") ON DELETE CASCADE
);
CREATE INDEX "callHistory_idCaller_created_at_idx" ON "callHistory"("idCaller", "created_at");
CREATE INDEX "callHistory_idReceiver_created_at_idx" ON "callHistory"("idReceiver", "created_at");

-- =============================================================
-- 10. RESERVED_ALANYA_PHONE (nouvelle table du référentiel)
-- =============================================================
CREATE TABLE "reserved_alanya_phone" (
  "id"              SERIAL PRIMARY KEY,
  "phone_canonical" VARCHAR(8) NOT NULL,
  "label"           VARCHAR(100) NOT NULL,
  "created_by"      UUID,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "reserved_alanya_phone_phone_canonical_key" UNIQUE ("phone_canonical"),
  CONSTRAINT "reserved_alanya_phone_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("alanyaID") ON DELETE SET NULL
);
