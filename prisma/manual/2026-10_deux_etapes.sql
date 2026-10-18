-- CONNEXION WEB EN DEUX ÉTAPES (18/10/2026).
--
-- Demande du patron : « juste le user password, c'est pas solide ». Pour se
-- connecter sur le WEB, un code est envoyé dans l'application Android, et on
-- le saisit dans le navigateur.
--   * au choix pour un particulier (Paramètres → Confidentialité) ;
--   * IMPOSÉ pour un agent d'entreprise (type de compte 2), « censé avoir
--     l'application sur le téléphone ».
-- La connexion sur le téléphone lui-même n'est pas concernée.

ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "deux_etapes" BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN "users"."deux_etapes" IS
    'Vrai : la connexion web demande un code envoyé dans l''application.';

-- Un défi par tentative de connexion web. Le code n'est JAMAIS gardé en
-- clair : seule son empreinte SHA-256.
CREATE TABLE IF NOT EXISTS "defi_connexion" (
    "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id"     UUID         NOT NULL REFERENCES "users"("alanyaID") ON DELETE CASCADE,
    "empreinte"   VARCHAR(64)  NOT NULL,
    "statut"      VARCHAR(12)  NOT NULL DEFAULT 'attente'
                  CHECK ("statut" IN ('attente', 'valide', 'refuse', 'epuise')),
    "tentatives"  SMALLINT     NOT NULL DEFAULT 0,
    "navigateur"  VARCHAR(200),
    "ip"          VARCHAR(64),
    "cree_le"     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    "expire_le"   TIMESTAMPTZ  NOT NULL
);

CREATE INDEX IF NOT EXISTS "defi_connexion_user_idx"
    ON "defi_connexion" ("user_id", "cree_le" DESC);
