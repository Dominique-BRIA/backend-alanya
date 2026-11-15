-- RENVOI PAR L'EXPÉDITEUR (piste B, 14/11/2026).
--
-- Un message chiffré à deux n'existe que dans les enveloppes de CHAQUE
-- appareil du destinataire. Si aucun d'eux ne l'a relevé avant de disparaître
-- (téléphone perdu, réinitialisé), le nouvel appareil ne peut pas le lire :
-- personne ne l'a chiffré pour lui. L'expéditeur, lui, garde le clair dans
-- son cache et dans son archive. Le nouvel appareil DEMANDE donc un renvoi ;
-- un appareil de l'expéditeur le rechiffre pour lui et le dépose.
--
-- Le serveur ne voit que des identifiants, jamais un contenu.
--
-- Rejouable sans effet.

CREATE TABLE IF NOT EXISTS "e2ee_renvois" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL REFERENCES "message"("msgID") ON DELETE CASCADE,
    "conversation_id" UUID NOT NULL,
    "expediteur_id" UUID NOT NULL,
    "demandeur_id" UUID NOT NULL,
    "demandeur_device" INTEGER NOT NULL,
    "cree_le" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "servi_le" TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS "e2ee_renvois_unique"
    ON "e2ee_renvois" ("message_id", "demandeur_id", "demandeur_device");

CREATE INDEX IF NOT EXISTS "e2ee_renvois_expediteur_idx"
    ON "e2ee_renvois" ("expediteur_id", "servi_le");
