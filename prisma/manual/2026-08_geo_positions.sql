-- Table `geo` — relevés de position des utilisateurs.
--
-- ⚠️ CETTE TABLE EXISTE DÉJÀ EN PRODUCTION. Elle y a été créée à la main, sans
-- passer par ce dossier : le dépôt ne savait donc pas la reproduire, et une base
-- neuve serait repartie sans elle. Ce fichier comble ce trou. Il est écrit à
-- l'IDENTIQUE de ce que `\d geo` renvoie en production — nom de la séquence,
-- nom de la contrainte de clé étrangère et nom de l'index compris — pour que
-- rejouer ce script sur la prod ne fasse strictement rien.
--
-- Rappel de la règle du dépôt : `scripts/apply-manual-sql.sh` rejoue TOUS les
-- fichiers de `prisma/manual/` à chaque déploiement. Tout doit donc rester
-- idempotent.

CREATE TABLE IF NOT EXISTS geo (
    "idGeo"      BIGSERIAL PRIMARY KEY,
    lat          NUMERIC(10, 7) NOT NULL,
    lon          NUMERIC(10, 7) NOT NULL,
    user_id      UUID NOT NULL,
    -- Pas de valeur par défaut : l'heure du relevé est celle du TÉLÉPHONE au
    -- moment où il a lu sa position, pas celle de l'insertion. Les deux
    -- diffèrent dès que le relevé a attendu dans une file hors ligne.
    collect_time TIMESTAMPTZ NOT NULL
);

-- Ajoutée à part : `ADD CONSTRAINT IF NOT EXISTS` n'existe pas en PostgreSQL,
-- d'où le passage par le catalogue.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'geo_user_id_fkey'
    ) THEN
        ALTER TABLE geo
            ADD CONSTRAINT geo_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users("alanyaID")
            ON UPDATE CASCADE ON DELETE CASCADE;
    END IF;
END $$;

-- Sert la seule lecture chaude : « quelle est la dernière position connue de cet
-- utilisateur ? », faite à CHAQUE relevé pour décider s'il a bougé.
CREATE INDEX IF NOT EXISTS geo_user_id_collect_time_idx ON geo (user_id, collect_time);
