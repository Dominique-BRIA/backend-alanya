-- LE SFU DE CLOUDFLARE POUR LES GROUPES ET LES RÉUNIONS (07/11/2026).
--
-- Tout est ADDITIF, et rien ne change tant que la console ne bascule pas sur
-- le SFU : un appel ou une réunion sans moteur noté reste en mesh, comme avant.
--
-- Rejouable sans effet : chaque instruction est conditionnelle.

-- L'application de ce compte sait-elle rejoindre un appel en SFU ? Posé par
-- le serveur temps réel quand une application à jour se connecte. Un groupe
-- ne passe en SFU que si TOUS ses membres l'ont : un téléphone pas encore mis
-- à jour ne saurait pas rejoindre l'appel.
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "capacite_sfu" BOOLEAN NOT NULL DEFAULT FALSE;

-- Le moteur d'un appel ou d'une réunion, fixé à son début : 'mesh' ou 'sfu'.
-- NULL = mesh (tout ce qui existait avant).
ALTER TABLE "calls"
    ADD COLUMN IF NOT EXISTS "moteur" VARCHAR(8);

ALTER TABLE "meeting"
    ADD COLUMN IF NOT EXISTS "moteur" VARCHAR(8);

-- Les sessions ouvertes chez Cloudflare : une par participant et par salle
-- (`call:<id>` ou `meeting:<id>`), avec les pistes qu'il publie. C'est ce qui
-- permet à chacun de recevoir les pistes des autres.
CREATE TABLE IF NOT EXISTS "sfu_session" (
    "session_id" VARCHAR(64) PRIMARY KEY,
    "salle"      VARCHAR(80) NOT NULL,
    "user_id"    UUID NOT NULL,
    "pistes"     JSONB NOT NULL DEFAULT '[]'::jsonb,
    "cree_le"    TIMESTAMPTZ NOT NULL DEFAULT now(),
    "ferme_le"   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "sfu_session_salle_ouverte"
    ON "sfu_session" ("salle") WHERE "ferme_le" IS NULL;
