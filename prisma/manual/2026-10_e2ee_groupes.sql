-- =============================================================
-- CHIFFREMENT DE BOUT EN BOUT DES GROUPES — le trousseau de groupe
-- =============================================================
-- Conception : docs/2026-10-08-e2ee-groupes-conception.md (§ 3).
-- Cours : chapitres 31 à 33. Lot 2, 09/10/2026.
--
-- QUE DES AJOUTS : aucune colonne renommée, aucune donnée touchée. Les
-- valeurs par défaut décrivent exactement la situation d'aujourd'hui (tout
-- participant existant est membre, aucun groupe n'a de clé).
--
-- ⚠️ PAS DE CLÉ ÉTRANGÈRE VERS `users`, comme `message_ouverture` : la base est
-- partagée avec un second système, qui peut effacer un compte par un chemin
-- que nous ne contrôlons pas.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

-- ── 1. L'appartenance : `isMembre` ─────────────────────────────────────────
-- Un participant qui part n'est plus SUPPRIMÉ : il reste, marqué. C'est ce qui
-- permet de savoir qui a eu accès, et de refuser de lui servir la suite.
ALTER TABLE "conv_participants"
  ADD COLUMN IF NOT EXISTS "est_membre" BOOLEAN     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "quitte_le"  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "exclu_par"  UUID        NULL;

-- 🔴 LA RÈGLE EST PORTÉE PAR LA BASE, pas seulement par le code : un membre n'a
-- ni date de départ ni exclueur ; un ancien membre a toujours sa date.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'conv_participants_depart_coherent') THEN
    ALTER TABLE "conv_participants"
      ADD CONSTRAINT "conv_participants_depart_coherent" CHECK (
        ("est_membre" AND "quitte_le" IS NULL AND "exclu_par" IS NULL)
        OR (NOT "est_membre" AND "quitte_le" IS NOT NULL)
      );
  END IF;
END $$;

-- Les membres ACTIFS d'une conversation : la question posée à chaque envoi.
CREATE INDEX IF NOT EXISTS "idx_conv_participants_actifs"
  ON "conv_participants" ("conversID")
  WHERE "est_membre";

-- ── 2. La version de clé courante d'une conversation ──────────────────────
-- 0 : jamais chiffrée en groupe. Elle ne fait que monter.
ALTER TABLE "conversation"
  ADD COLUMN IF NOT EXISTS "cle_version" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'conversation_cle_version_positive') THEN
    ALTER TABLE "conversation"
      ADD CONSTRAINT "conversation_cle_version_positive" CHECK ("cle_version" >= 0);
  END IF;
END $$;

-- ── 3. Les versions de clé : la numérotation, tenue par le serveur ────────
-- Le serveur ne connaît PAS les clés : seulement qu'une version existe, qui
-- l'a créée, et pourquoi. La clé primaire (conversation, version) interdit
-- deux versions au même numéro, même si deux appareils se croisent.
CREATE TABLE IF NOT EXISTS "e2ee_cle_versions" (
  "conv_id"           UUID        NOT NULL
    REFERENCES "conversation"("conversID") ON DELETE CASCADE,
  "version"           INTEGER     NOT NULL,
  "cree_par"          UUID        NOT NULL,
  "cree_par_appareil" INTEGER     NOT NULL,
  "motif"             VARCHAR(12) NOT NULL,
  "cree_le"           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "e2ee_cle_versions_pkey" PRIMARY KEY ("conv_id", "version"),
  CONSTRAINT "e2ee_cle_versions_version_positive" CHECK ("version" >= 1),
  CONSTRAINT "e2ee_cle_versions_motif_connu"
    CHECK ("motif" IN ('ACTIVATION', 'EXCLUSION', 'MANUEL'))
);

-- ── 4. Le message de groupe chiffré : UNE ligne par message ───────────────
-- Quel que soit le nombre de membres. Pas d'acquittement : il reste lisible
-- par les membres, comme un message ordinaire, et part avec son message.
--
-- ⚠️ La clé étrangère (conversation, version) interdit un chiffré sous une
-- version qui n'existe pas.
CREATE TABLE IF NOT EXISTS "e2ee_messages_groupe" (
  "message_id"          UUID        NOT NULL
    REFERENCES "message"("msgID") ON DELETE CASCADE,
  "conv_id"             UUID        NOT NULL
    REFERENCES "conversation"("conversID") ON DELETE CASCADE,
  "version"             INTEGER     NOT NULL,
  "expediteur_appareil" INTEGER     NOT NULL,
  "corps"               TEXT        NOT NULL,
  "maj_le"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "e2ee_messages_groupe_pkey" PRIMARY KEY ("message_id"),
  CONSTRAINT "e2ee_messages_groupe_version_fkey"
    FOREIGN KEY ("conv_id", "version")
    REFERENCES "e2ee_cle_versions"("conv_id", "version") ON DELETE CASCADE,
  -- 64 Ko de chiffré, en base64 : un peu moins de 90 000 caractères.
  CONSTRAINT "e2ee_messages_groupe_corps_borne" CHECK (char_length("corps") <= 90000)
);

CREATE INDEX IF NOT EXISTS "idx_e2ee_messages_groupe_conv"
  ON "e2ee_messages_groupe" ("conv_id");

-- ── 5. La copie personnelle du trousseau, pour changer de téléphone ───────
-- Chiffrée par la clé maîtresse de l'archive du membre : illisible ici.
-- Rangée À PART de l'archive des messages, pour pouvoir être SUPPRIMÉE seule
-- quand le membre part.
CREATE TABLE IF NOT EXISTS "e2ee_trousseaux" (
  "alanyaID" UUID        NOT NULL,
  "conv_id"  UUID        NOT NULL
    REFERENCES "conversation"("conversID") ON DELETE CASCADE,
  "corps"    TEXT        NOT NULL,
  "maj_le"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "e2ee_trousseaux_pkey" PRIMARY KEY ("alanyaID", "conv_id"),
  -- ~50 octets par version : un million de caractères laisse de la marge
  -- pour des milliers de versions.
  CONSTRAINT "e2ee_trousseaux_corps_borne" CHECK (char_length("corps") <= 1000000)
);

CREATE INDEX IF NOT EXISTS "idx_e2ee_trousseaux_conv"
  ON "e2ee_trousseaux" ("conv_id");
