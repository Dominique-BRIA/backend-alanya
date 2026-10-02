-- =============================================================
-- MESSAGES À VUE UNIQUE (photo, vidéo, vocal)
-- =============================================================
-- Demandé le 02/10/2026 : « fait l'envoi d'un fichier à vue unique comme
-- dans WhatsApp ». Chaque destinataire ouvre le média UNE fois ; ensuite le
-- fichier est EFFACÉ du stockage (Backblaze, toutes versions comprises).
--
-- DEUX OBJETS.
--
--   `message.vue_unique` : le drapeau, posé à l'envoi. Faux pour tout
--   l'historique — rien ne change pour les messages existants.
--
--   `message_ouverture` : une ligne par (message, destinataire), écrite à
--   l'ouverture. C'est ELLE qui ferme l'accès : passé la fenêtre d'ouverture
--   ou dès la fermeture du visionneur, la route des médias refuse. Quand tous
--   les destinataires ont la leur, le fichier part.
--
-- ⚠️ PAS DE CLÉ ÉTRANGÈRE VERS `users`, comme `message_mention` : la base est
-- partagée avec un second système, qui peut effacer un compte par un chemin
-- que nous ne contrôlons pas.
--
-- ⚠️ CLÉ PRIMAIRE (message, destinataire) : une seconde ouverture par la même
-- personne ne crée pas de seconde ligne — c'est l'unicité qui fait la « vue
-- unique », pas une vérification applicative qu'une course pourrait doubler.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "message"
  ADD COLUMN IF NOT EXISTS "vue_unique" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "message_ouverture" (
  "idMessage" UUID        NOT NULL
    REFERENCES "message"("msgID") ON DELETE CASCADE,
  "userId"    UUID        NOT NULL,
  "ouvertA"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "fermeA"    TIMESTAMPTZ NULL,
  CONSTRAINT "message_ouverture_pkey" PRIMARY KEY ("idMessage", "userId")
);

-- La purge cherche les messages à vue unique dont le fichier n'est pas encore
-- effacé. Index PARTIEL : il ne contient que ces messages-là, une poignée
-- parmi des centaines de milliers — et il ne coûte rien aux autres envois.
CREATE INDEX IF NOT EXISTS "idx_message_vue_unique"
  ON "message" ("sendAt")
  WHERE "vue_unique";
