-- Un compte, un téléphone : le téléphone lié et sa dissociation explicite.
--
-- Demande du user, 28/09/2026. Jusqu'ici, se connecter sur un téléphone B
-- déconnectait le téléphone A. Désormais la connexion sur B est REFUSÉE tant
-- que l'utilisateur n'a pas appuyé sur « Dissocier ce téléphone » depuis A.
--
--   users."device_ID" : identifiant du téléphone lié (le `cookies_WebID` que
--                       l'application tire au sort à sa première ouverture).
--                       Colonne du référentiel équipe, VIDE pour tous les
--                       comptes et lue par aucun code avant ce lot.
--   users.dissocier   : vrai = le compte n'est lié à aucun téléphone.
--
-- 🔴 LES DEUX CHAMPS NE PEUVENT PAS SE CONTREDIRE, ET C'EST LA BASE QUI LE
-- GARANTIT. `dissocier` redit ce que `"device_ID" IS NULL` dit déjà : laissé
-- libre, un seul oubli dans le code donnerait « dissocié mais lié » ou
-- « lié à personne », et selon le champ lu la connexion serait acceptée ou
-- refusée. La contrainte rend ces états impossibles, au lieu de les rendre
-- improbables.
--
-- ⚠️ POURQUOI UN BLOC CONDITIONNEL. `scripts/apply-manual-sql.sh` rejoue ce
-- fichier à CHAQUE déploiement. La liaison initiale, rejouée, relierait chaque
-- compte à son téléphone du moment — y compris un compte que l'utilisateur
-- vient de dissocier. L'absence de la colonne sert de témoin : le bloc ne
-- s'exécute qu'une fois dans la vie de la base.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'dissocier'
    ) THEN
        -- Libre par défaut : un compte qui naît n'est lié à rien. La
        -- connexion (ou l'inscription) le lie. ⚠️ Le schéma Prisma porte le
        -- MÊME défaut, sans quoi il enverrait le sien à chaque création.
        ALTER TABLE users ADD COLUMN dissocier BOOLEAN NOT NULL DEFAULT true;

        /*
         * Liaison initiale : chaque compte est lié au téléphone dont la session
         * est vivante, le plus récemment actif s'il y en a deux.
         *
         * ⚠️ LE TÉLÉPHONE SE RECONNAÎT À SON PRÉFIXE `mob-`, PAS AU REGISTRE.
         * Mesuré le 28/09/2026 : 23 sessions mobiles vivantes n'ont AUCUNE
         * ligne dans "Appareil". Filtrer par `typeDevice` aurait laissé libres
         * des comptes pourtant ouverts sur un téléphone.
         *
         * « Le plus récemment actif » se lit sur `createdAt` du jeton : la
         * rotation en émet un nouveau à chaque rafraîchissement, c'est donc la
         * date de la dernière activité et non celle de la connexion. Deux
         * comptes avaient deux téléphones vivants à la fois (l'un hors
         * registre, que l'éviction ne voyait pas) ; l'autre est refusé au
         * rafraîchissement par le code, pas ici.
         */
        UPDATE users u
           SET "device_ID" = lie.device_id,
               dissocier   = false
          FROM (
                SELECT DISTINCT ON ("userId") "userId", device_id
                  FROM refresh_tokens
                 WHERE NOT revoked
                   AND "expiresAt" > now()
                   AND device_id LIKE 'mob-%'
                 ORDER BY "userId", "createdAt" DESC
               ) lie
         WHERE u."alanyaID" = lie."userId";

        RAISE NOTICE 'dissocier : colonne créée, comptes liés à leur téléphone actif';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_dissocier_coherent'
    ) THEN
        ALTER TABLE users
          ADD CONSTRAINT users_dissocier_coherent
          CHECK (dissocier = ("device_ID" IS NULL));
    END IF;
END $$;
