-- GROUPES PRIVÉS ET PUBLICS, LIEN ET QR CODE D'UN GROUPE (18/11/2026).
--
-- Demande du user : chaque groupe a un lien (et son QR code). Dans un groupe
-- PUBLIC, l'ouvrir fait entrer aussitôt ; dans un groupe PRIVÉ, il place la
-- personne dans une liste d'attente que les administrateurs acceptent ou
-- refusent. Le type se choisit à la création et se change dans les réglages.
--
-- Tout est ADDITIF. Les groupes existants deviennent PRIVÉS : personne n'y
-- entre sans l'accord d'un administrateur, comme avant. Leur code de lien est
-- créé à la première demande, pas ici.
--
-- Rejouable sans effet : chaque instruction est conditionnelle.

ALTER TABLE "conversation"
    ADD COLUMN IF NOT EXISTS "acces" VARCHAR(10) NOT NULL DEFAULT 'prive',
    ADD COLUMN IF NOT EXISTS "code_lien" VARCHAR(43);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'conversation_acces_check'
    ) THEN
        ALTER TABLE "conversation"
            ADD CONSTRAINT "conversation_acces_check" CHECK ("acces" IN ('prive', 'public'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "conversation_code_lien_key" ON "conversation" ("code_lien");

-- UNE LIGNE PAR (GROUPE, PERSONNE) : une nouvelle demande après un refus
-- réutilise la ligne et la remet « en attente ».
CREATE TABLE IF NOT EXISTS "demande_adhesion" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "conv_id"     UUID        NOT NULL REFERENCES "conversation" ("conversID") ON DELETE CASCADE,
    "user_id"     UUID        NOT NULL REFERENCES "users" ("alanyaID") ON DELETE CASCADE,
    "statut"      VARCHAR(10) NOT NULL DEFAULT 'attente'
                  CHECK ("statut" IN ('attente', 'acceptee', 'refusee')),
    "cree_le"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "traitee_par" UUID,
    "traitee_le"  TIMESTAMPTZ,
    PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "demande_adhesion_conv_id_user_id_key"
    ON "demande_adhesion" ("conv_id", "user_id");
CREATE INDEX IF NOT EXISTS "demande_adhesion_conv_id_statut_idx"
    ON "demande_adhesion" ("conv_id", "statut");
