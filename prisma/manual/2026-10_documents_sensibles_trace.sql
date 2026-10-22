-- DOCUMENTS SENSIBLES : CE QUI SORT EST TRACÉ (22/10/2026).
--
-- Le téléchargement et le partage d'un document sensible ne sont plus
-- interdits. La copie qui sort est signée sur l'appareil : texte aux quatre
-- bords (PDF, images) et métadonnées (Alanya ID, appareil, date, application,
-- CODE DE TRACE). Le serveur garde, pour chaque sortie, le geste et ce code :
-- un fichier retrouvé ailleurs renvoie, par son code, à qui l'a fait sortir.
--
-- Les lignes existantes sont des consultations : la valeur par défaut le dit.
ALTER TABLE "document_consultation"
    ADD COLUMN IF NOT EXISTS "action" VARCHAR(16) NOT NULL DEFAULT 'CONSULTATION';

ALTER TABLE "document_consultation"
    ADD COLUMN IF NOT EXISTS "code_trace" VARCHAR(32);

-- La liste des gestes est tenue par la base, pas seulement par la route.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'document_consultation_action_chk'
    ) THEN
        ALTER TABLE "document_consultation"
            ADD CONSTRAINT "document_consultation_action_chk"
            CHECK ("action" IN ('CONSULTATION', 'TELECHARGEMENT', 'PARTAGE', 'TRANSFERT'));
    END IF;
END $$;

-- Un code désigne une seule sortie (plusieurs NULL restent permis).
CREATE UNIQUE INDEX IF NOT EXISTS "document_consultation_code_idx"
    ON "document_consultation" ("code_trace");

COMMENT ON COLUMN "document_consultation"."code_trace" IS
    'Code écrit dans les métadonnées de la copie signée (32 caractères hexadécimaux).';
