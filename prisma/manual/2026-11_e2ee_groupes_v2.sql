-- CHIFFREMENT DES GROUPES, VERSION 2 — lot 2 (11/11/2026).
-- Conception : docs/2026-11-11-e2ee-groupes-v2-conception.md.
--
-- Tout est ADDITIF : rien d'existant ne change, les clients actuels ne voient
-- aucune différence tant qu'ils n'écrivent pas dans ces tables.
--
-- Rejouable sans effet : chaque instruction est conditionnelle.

-- LA CLÉ DU COMPTE (§ 3.1) : une paire X25519 par compte. La partie privée
-- est chiffrée par la clé maîtresse de l'archive de son propriétaire
-- (Argon2id sur son mot de passe) : illisible ici.
CREATE TABLE IF NOT EXISTS "e2ee_cles_compte" (
    "alanyaID"        UUID PRIMARY KEY REFERENCES "users"("alanyaID") ON DELETE CASCADE,
    "version"         INT NOT NULL DEFAULT 1,
    "publique"        VARCHAR(64) NOT NULL,
    "privee_chiffree" TEXT NOT NULL,
    "cree_le"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    "maj_le"          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LES EMBALLAGES DE GROUPE (§ 3.2) : la clé d'une version d'un groupe,
-- scellée pour la clé de compte (dans sa version) d'un membre. Permanents :
-- tout appareil du membre les relit quand il veut. Premier dépôt gagnant.
CREATE TABLE IF NOT EXISTS "e2ee_emballages" (
    "conv_id"        UUID NOT NULL REFERENCES "conversation"("conversID") ON DELETE CASCADE,
    "alanyaID"       UUID NOT NULL REFERENCES "users"("alanyaID") ON DELETE CASCADE,
    "version"        INT NOT NULL,
    "version_compte" INT NOT NULL,
    "corps"          TEXT NOT NULL,
    "depose_par"     UUID NOT NULL,
    "depose_le"      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY ("conv_id", "alanyaID", "version", "version_compte")
);

CREATE INDEX IF NOT EXISTS "idx_e2ee_emballages_destinataire"
    ON "e2ee_emballages" ("alanyaID", "conv_id");
