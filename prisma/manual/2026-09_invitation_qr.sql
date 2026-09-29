-- ===========================================================================
-- invitation_qr — le QR code à usage unique, valable 15 minutes
--
-- Demande du user, 29/09/2026. Un QR (lien https://alanyavox.com/i/<jeton>)
-- que l'on partage sur WhatsApp, Facebook… Celui qui l'utilise et son
-- créateur s'ajoutent MUTUELLEMENT aux contacts, et leur conversation s'ouvre.
-- Décisions du user : le lien ne révèle pas l'Alanya ID ; plusieurs
-- invitations peuvent être actives à la fois ; pas d'annulation, elles
-- expirent seules ; création freinée à 30 par heure et par compte (Redis,
-- dans la route — pas ici).
--
-- Table À NOUS, pas au référentiel équipe : aucune de leurs tables n'est touchée.
-- Noms d'objets relevés dans `prisma migrate diff`, pas inventés.
--
-- 🔒 CE QUE LA BASE GARANTIT, pour que le code ne puisse pas l'oublier :
--   · une invitation utilisée l'est PAR QUELQU'UN, à un MOMENT : les deux
--     colonnes sont vides ensemble ou remplies ensemble ;
--   · on ne s'invite pas soi-même ;
--   · une invitation expire après sa création.
-- L'usage UNIQUE, lui, tient à la forme de l'utilisation — un seul
-- `UPDATE … WHERE utilisee_le IS NULL AND expire_le > now()` — et non à une
-- lecture suivie d'une écriture, qui laisserait passer deux clics simultanés.
--
-- Idempotent : rejoué à chaque déploiement par `scripts/apply-manual-sql.sh`.
-- ===========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS "invitation_qr" (
    "jeton"        VARCHAR(43)  NOT NULL,
    "createur_id"  UUID         NOT NULL,
    "cree_le"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expire_le"    TIMESTAMPTZ  NOT NULL,
    "utilisee_le"  TIMESTAMPTZ,
    "utilisee_par" UUID,

    CONSTRAINT "invitation_qr_pkey" PRIMARY KEY ("jeton"),
    CONSTRAINT "invitation_qr_utilisation_complete"
        CHECK (("utilisee_le" IS NULL) = ("utilisee_par" IS NULL)),
    CONSTRAINT "invitation_qr_pas_soi_meme"
        CHECK ("utilisee_par" IS NULL OR "utilisee_par" <> "createur_id"),
    CONSTRAINT "invitation_qr_expire_apres_creation"
        CHECK ("expire_le" > "cree_le")
);

-- Le ménage des invitations périmées (fait à chaque création) filtre sur la
-- date d'expiration.
CREATE INDEX IF NOT EXISTS "invitation_qr_expire_le_idx"
    ON "invitation_qr" ("expire_le");

-- ⚠️ CASCADE des deux côtés, y compris pour `utilisee_par`. Un SET NULL
-- violerait `invitation_qr_utilisation_complete` à la suppression du compte
-- qui l'a utilisée ; et une invitation utilisée n'a plus rien à garder.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitation_qr_createur_id_fkey') THEN
        ALTER TABLE "invitation_qr"
            ADD CONSTRAINT "invitation_qr_createur_id_fkey"
            FOREIGN KEY ("createur_id") REFERENCES "users"("alanyaID")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitation_qr_utilisee_par_fkey') THEN
        ALTER TABLE "invitation_qr"
            ADD CONSTRAINT "invitation_qr_utilisee_par_fkey"
            FOREIGN KEY ("utilisee_par") REFERENCES "users"("alanyaID")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

COMMIT;
