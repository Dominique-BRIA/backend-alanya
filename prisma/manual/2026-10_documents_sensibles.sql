-- DOCUMENTS SENSIBLES (18/10/2026).
--
-- Demande du patron : un document envoyé comme « sensible » est, au
-- téléchargement, « signé » du numéro Alanya de qui l'ouvre, de la marque de
-- son appareil, de la date et de l'heure — et ne peut pas être repartagé.
--
-- Le filigrane se pose dans l'application (le fichier est chiffré de bout en
-- bout : le serveur ne le lit pas). Cette table garde la TRACE de chaque
-- consultation, côté serveur, pour qui devra un jour remonter une fuite.
CREATE TABLE IF NOT EXISTS "document_consultation" (
    "id"        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id"   UUID         NOT NULL REFERENCES "users"("alanyaID") ON DELETE CASCADE,
    "media_id"  VARCHAR(64)  NOT NULL,
    "conv_id"   VARCHAR(64),
    "appareil"  VARCHAR(200),
    "ip"        VARCHAR(64),
    "cree_le"   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "document_consultation_media_idx"
    ON "document_consultation" ("media_id", "cree_le" DESC);
