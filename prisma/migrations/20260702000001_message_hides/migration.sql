-- Table: message_hides
-- Permet la suppression « pour moi » d'un message (masqué de la vue de l'utilisateur,
-- les autres participants le voient toujours). Inclut un @@unique(userId, messageId).
CREATE TABLE "message_hides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_hides_pkey" PRIMARY KEY ("id")
);

-- Index unique : un utilisateur ne peut masquer un message qu'une fois.
CREATE UNIQUE INDEX "message_hides_userId_messageId_key" ON "message_hides"("userId", "messageId");

-- Index de recherche : « quels messages cet utilisateur a-t-il masqués ? »
CREATE INDEX "message_hides_userId_idx" ON "message_hides"("userId");

-- Clés étrangères avec suppression en cascade.
ALTER TABLE "message_hides"
    ADD CONSTRAINT "message_hides_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "message_hides"
    ADD CONSTRAINT "message_hides_messageId_fkey"
    FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE;
