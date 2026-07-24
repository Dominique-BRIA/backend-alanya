-- ROLLBACK de 20260724120000_harmonisation_referentiel
-- Restaure les noms d'origine pour que le backend déployé (qui attend `id`,
-- `name`, `convId`, etc.) refonctionne. Renommages inverses : aucune donnée perdue.
-- Les colonnes/tables ajoutées (vides) sont supprimées.

-- 1. USERS
ALTER TABLE "users" RENAME COLUMN "alanyaID" TO "id";
ALTER TABLE "users" RENAME COLUMN "password" TO "passwordHash";
ALTER TABLE "users" RENAME COLUMN "alanyaPhone" TO "publicNumber";
ALTER TABLE "users" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "users"
  DROP COLUMN "exclude_at",
  DROP COLUMN "exclude_reason",
  DROP COLUMN "in_call",
  DROP COLUMN "biometric",
  DROP COLUMN "fcm_token",
  DROP COLUMN "device_ID",
  DROP COLUMN "reset_otp",
  DROP COLUMN "reset_otp_expires_at";

-- 2. preferredContact -> contacts
ALTER TABLE "preferredContact" RENAME COLUMN "idPrefContact" TO "id";
ALTER TABLE "preferredContact" RENAME COLUMN "alanyaID" TO "userId";
ALTER TABLE "preferredContact" RENAME COLUMN "idFriend" TO "contactId";
ALTER TABLE "preferredContact" RENAME COLUMN "created_at" TO "createdAt";
ALTER TABLE "preferredContact" RENAME TO "contacts";

-- 3. conversation -> conversations
ALTER TABLE "conversation" RENAME COLUMN "conversID" TO "id";
ALTER TABLE "conversation" RENAME COLUMN "GroupName" TO "name";
ALTER TABLE "conversation" RENAME COLUMN "groupPhoto" TO "avatarUrl";
ALTER TABLE "conversation" RENAME TO "conversations";

-- 4. conv_participants -> participants
ALTER TABLE "conv_participants" RENAME COLUMN "conversID" TO "convId";
ALTER TABLE "conv_participants" RENAME COLUMN "alanyaID" TO "userId";
ALTER TABLE "conv_participants" RENAME TO "participants";

-- 5. message -> messages
ALTER TABLE "message" RENAME COLUMN "msgID" TO "id";
ALTER TABLE "message" RENAME COLUMN "conversationID" TO "convId";
ALTER TABLE "message" RENAME COLUMN "senderID" TO "senderId";
ALTER TABLE "message" RENAME COLUMN "replyToID" TO "replyToId";
ALTER TABLE "message" RENAME COLUMN "sendAt" TO "createdAt";
ALTER TABLE "message" RENAME TO "messages";

-- 6. statut -> statuses
ALTER TABLE "statut" RENAME COLUMN "ID" TO "id";
ALTER TABLE "statut" RENAME COLUMN "alanyaID" TO "userId";
ALTER TABLE "statut" RENAME COLUMN "backgroundColor" TO "bgColor";
ALTER TABLE "statut" RENAME COLUMN "expiredAt" TO "expiresAt";
ALTER TABLE "statut" RENAME TO "statuses";

-- 7. statut_views -> status_views
ALTER TABLE "statut_views" RENAME COLUMN "statutID" TO "statusId";
ALTER TABLE "statut_views" RENAME COLUMN "alanyaID" TO "viewerId";
ALTER TABLE "statut_views" RENAME COLUMN "seenAt" TO "viewedAt";
ALTER TABLE "statut_views" RENAME TO "status_views";

-- 8. Supprimer les nouvelles tables (vides)
DROP TABLE IF EXISTS "userAccess";
DROP TABLE IF EXISTS "callHistory";
DROP TABLE IF EXISTS "reserved_alanya_phone";
