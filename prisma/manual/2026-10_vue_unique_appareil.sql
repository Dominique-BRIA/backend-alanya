-- UNE VUE, UN APPAREIL (12/10/2026).
--
-- Demande du user : « si je l'ouvre déjà avec mon compte sur un appareil, en
-- allant sur l'autre appareil, on ne doit pas pouvoir l'ouvrir ».
--
-- La clé primaire `(idMessage, userId)` garantissait déjà UNE ouverture par
-- compte. Mais la fenêtre de reprise de cinq minutes — qui existe pour qu'un
-- réseau coupé ne fasse pas perdre la photo — ne regardait pas QUI reprenait :
-- un second appareil du même compte pouvait voir le média pendant ce temps.
--
-- ⚠️ NULLE POUR LES OUVERTURES DÉJÀ EN BASE, et pour les clients qui ne
-- l'envoient pas : on retombe alors sur l'ancien comportement, tolérant. Une
-- photo perdue par un réseau coupé serait pire qu'une reprise trop permissive.
ALTER TABLE "message_ouverture"
    ADD COLUMN IF NOT EXISTS "appareil" VARCHAR(64);

COMMENT ON COLUMN "message_ouverture"."appareil" IS
    'Appareil qui a commencé l''ouverture : seul lui peut la reprendre.';
