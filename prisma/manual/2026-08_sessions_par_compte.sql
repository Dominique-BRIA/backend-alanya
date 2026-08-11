-- Nombre de sessions simultanées autorisées par compte.
--
-- `users.appareil_total` existe depuis le référentiel équipe, avec un défaut de
-- 1, et AUCUN code ne le lisait. Il devient la limite effective : 1 session
-- mobile + (appareil_total − 1) sessions web.
--
-- 🔴 SANS CETTE MIGRATION, LIRE LA COLONNE COUPERAIT LE WEB À TOUT LE MONDE.
-- Les 59 comptes de production sont à 1, ce qui signifierait « 1 mobile,
-- 0 navigateur ». La valeur voulue est 2 : un mobile et un navigateur.
--
-- ⚠️ POURQUOI CE BLOC CONDITIONNEL, ET PAS UN SIMPLE UPDATE.
--
-- `scripts/apply-manual-sql.sh` rejoue TOUS les fichiers de ce dossier à CHAQUE
-- déploiement. Un `UPDATE users SET appareil_total = 2 WHERE appareil_total < 2`
-- écrirait donc à chaque fois — et écraserait silencieusement, à chaque
-- livraison, tout compte que la plateforme d'administration aurait délibérément
-- remis à 1. Le collègue verrait son réglage annulé sans explication, une fois
-- par déploiement.
--
-- La valeur par défaut de la colonne sert donc de témoin : elle vaut 1 tant que
-- cette migration n'a jamais tourné, 2 ensuite. Le bloc ne s'exécute qu'une
-- seule fois dans la vie de la base, et les réglages manuels qui suivront sont
-- définitivement à l'abri.

DO $$
BEGIN
    IF (
        SELECT column_default
          FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'appareil_total'
    ) = '1' THEN
        -- Les comptes existants d'abord : ils doivent garder leur accès web.
        UPDATE users SET appareil_total = 2 WHERE appareil_total < 2;
        -- Puis le défaut, pour que les comptes créés ensuite naissent avec les
        -- deux sessions. ⚠️ Le schéma Prisma porte le MÊME défaut : sans cela,
        -- Prisma enverrait explicitement 1 à chaque création et le défaut de la
        -- base ne servirait jamais.
        ALTER TABLE users ALTER COLUMN appareil_total SET DEFAULT 2;
        RAISE NOTICE 'appareil_total : comptes existants passés à 2, défaut relevé à 2';
    END IF;
END $$;
