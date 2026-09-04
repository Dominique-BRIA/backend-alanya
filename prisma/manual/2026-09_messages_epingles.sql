-- PLUSIEURS MESSAGES ÉPINGLÉS PAR CONVERSATION.
--
-- Jusqu'ici l'épinglage tenait dans UNE colonne posée sur la conversation
-- (`conversation.pinned_message_id`, migration 2026-07). Épingler un second
-- message écrasait donc silencieusement le premier — ce n'était pas un défaut de
-- code, c'était la limite du modèle.
--
-- ⚠️ LA COLONNE D'ORIGINE EST CONSERVÉE ET TENUE À JOUR. L'application mobile la
-- lit encore : la supprimer ferait disparaître le bandeau épinglé chez tous les
-- utilisateurs qui n'ont pas mis à jour, c'est-à-dire tous, le jour du
-- déploiement. Elle pointe désormais le plus RÉCENT des épinglés, ce qui donne
-- exactement le comportement d'avant à un client qui ne connaît que ce champ.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

CREATE TABLE IF NOT EXISTS "message_pinned" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversID"   uuid        NOT NULL,
  "messageID"   uuid        NOT NULL,
  -- Qui a épinglé : sert au message système « X a épinglé un message », et à
  -- décider qui peut détacher.
  "alanyaID"    uuid        NOT NULL,
  "pinned_at"   timestamptz NOT NULL DEFAULT now()
);

-- ÉPINGLER DEUX FOIS LE MÊME MESSAGE N'A PAS DE SENS : la contrainte le refuse
-- au niveau de la base plutôt que de compter sur le client. Elle sert aussi
-- d'index pour la lecture, qui part toujours de la conversation.
CREATE UNIQUE INDEX IF NOT EXISTS "message_pinned_conv_message_key"
  ON "message_pinned" ("conversID", "messageID");

-- La liste s'affiche du plus récent au plus ancien : l'index porte l'ordre.
CREATE INDEX IF NOT EXISTS "message_pinned_conv_date_idx"
  ON "message_pinned" ("conversID", "pinned_at" DESC);

-- Les clés étrangères en CASCADE : supprimer une conversation ou un message
-- doit emporter ses épingles. Sans elles, un bandeau pointerait un message
-- effacé — le « bandeau fantôme » déjà corrigé côté client, mais qui doit aussi
-- être impossible côté base.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_pinned_conv_fkey'
  ) THEN
    ALTER TABLE "message_pinned"
      ADD CONSTRAINT "message_pinned_conv_fkey"
      FOREIGN KEY ("conversID") REFERENCES "conversation"("conversID") ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_pinned_message_fkey'
  ) THEN
    ALTER TABLE "message_pinned"
      ADD CONSTRAINT "message_pinned_message_fkey"
      FOREIGN KEY ("messageID") REFERENCES "message"("msgID") ON DELETE CASCADE;
  END IF;
END $$;

-- REPRISE DE L'EXISTANT : les épingles déjà posées sous l'ancien modèle
-- deviennent la première ligne de la nouvelle table. Sans cela, un message
-- épinglé avant le déploiement disparaîtrait du bandeau.
--
-- `alanyaID` prend l'organisateur de la conversation faute de mieux : l'ancien
-- modèle ne retenait pas QUI avait épinglé. C'est une valeur de reprise, pas une
-- vérité — elle ne sert qu'aux futurs contrôles de droits.
INSERT INTO "message_pinned" ("conversID", "messageID", "alanyaID", "pinned_at")
SELECT c."conversID",
       c."pinned_message_id",
       COALESCE(
         (SELECT p."alanyaID" FROM "conv_participants" p
           WHERE p."conversID" = c."conversID" ORDER BY p."joinedAt" ASC LIMIT 1),
         c."pinned_message_id"
       ),
       now()
FROM "conversation" c
WHERE c."pinned_message_id" IS NOT NULL
ON CONFLICT ("conversID", "messageID") DO NOTHING;
