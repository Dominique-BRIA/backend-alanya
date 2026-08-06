-- ===========================================================================
-- Verrou de conversation + appareil emetteur d'un message
--
-- CORRECTIF D'INCIDENT. Les commits `feat(verrou)` et `feat(pseudo-appareil)`
-- ont ajoute `ConversationLock` et `Message.appareilId` au schema Prisma, mais
-- AUCUNE migration ne creait les objets correspondants. La base est batie en
-- SQL manuel : ce qui n'est pas ecrit ici n'existe pas.
--
-- Consequence observee en production le 06/08/2026, 178 fois dans
-- `alanya-api-out.log` :
--
--   Invalid `prisma.participant.findMany()` invocation:
--   The column `message.appareilID` does not exist in the current database.
--
-- C'est la requete de `GET /api/conversations`. Prisma selectionne TOUTES les
-- colonnes declarees du modele `Message`, y compris celle qui manque : la
-- liste des discussions echouait donc a chaque appel, pour tout le monde. Le
-- verrou, interroge plus loin dans la meme route, n'etait meme jamais atteint.
--
-- Les noms d'objets sont ceux que Prisma attend, releves dans la sortie de
-- `prisma migrate diff` — pas inventes. Un nom different laisserait la base
-- fonctionnelle mais ferait diverger tout futur diff.
--
-- Idempotent : rejoue a chaque deploiement par `scripts/apply-manual-sql.sh`.
-- ===========================================================================

BEGIN;

-- --------------------------------------------------------------------------
-- 1. `message.appareilID` — quel appareil du compte a envoye le message.
--
--    NULLABLE, et ce n'est pas un detail : les 1 379 messages deja en base
--    n'ont pas d'appareil connu, et un client qui ne le transmet pas reste
--    valide. Aucune cle etrangere non plus — la ligne d'appareil peut etre
--    retiree sans emporter les messages deja envoyes.
-- --------------------------------------------------------------------------
ALTER TABLE "message" ADD COLUMN IF NOT EXISTS "appareilID" INTEGER;

-- --------------------------------------------------------------------------
-- 2. `conversation_lock` — quel appareil d'un compte a la main sur une
--    conversation. Repartit l'ecriture entre les appareils d'un MEME compte.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "conversation_lock" (
    "id"          UUID         NOT NULL,
    "conversID"   UUID         NOT NULL,
    "alanyaID"    UUID         NOT NULL,
    "appareilID"  INTEGER      NOT NULL,
    "detenteur"   VARCHAR(80),
    "locked_at"   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at"  TIMESTAMPTZ  NOT NULL,

    CONSTRAINT "conversation_lock_pkey" PRIMARY KEY ("id")
);

-- Un seul verrou par (conversation, compte) : c'est entre appareils d'un meme
-- compte que la main se passe.
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_lock_conversID_alanyaID_key"
  ON "conversation_lock" ("conversID", "alanyaID");

CREATE INDEX IF NOT EXISTS "conversation_lock_alanyaID_idx"
  ON "conversation_lock" ("alanyaID");

-- Les verrous perimes sont ecartes a CHAQUE lecture de la liste des
-- discussions : sans cet index, ce filtre parcourrait toute la table.
CREATE INDEX IF NOT EXISTS "conversation_lock_expires_at_idx"
  ON "conversation_lock" ("expires_at");

-- --------------------------------------------------------------------------
-- 3. Cles etrangeres.
--
--    `ADD CONSTRAINT` n'accepte pas `IF NOT EXISTS` : on interroge le
--    catalogue. Les colonnes referencees ne s'appellent PAS `id` — la
--    conversation est designee par `conversID` et le compte par `alanyaID`,
--    heritage de l'harmonisation sur le referentiel de l'equipe.
--
--    Aucune cle sur `appareilID` : `Appareil.idAgent` n'est pas unique, et le
--    verrou ne doit pas tomber si la ligne d'appareil disparait.
-- --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_lock_conversID_fkey'
  ) THEN
    ALTER TABLE "conversation_lock"
      ADD CONSTRAINT "conversation_lock_conversID_fkey"
      FOREIGN KEY ("conversID") REFERENCES "conversation"("conversID")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_lock_alanyaID_fkey'
  ) THEN
    ALTER TABLE "conversation_lock"
      ADD CONSTRAINT "conversation_lock_alanyaID_fkey"
      FOREIGN KEY ("alanyaID") REFERENCES "users"("alanyaID")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

COMMIT;
