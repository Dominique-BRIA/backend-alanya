-- Décision de l'utilisateur sur le suivi de sa position.
--
-- ⚠️ POURQUOI CETTE TABLE EXISTE. L'écran de divulgation promet à l'utilisateur
-- que « votre entreprise sera informée que le suivi n'est pas actif ». Sans
-- cette table, la décision ne vivait que dans les préférences du téléphone : le
-- serveur ne l'apprenait jamais, et l'écran énonçait une promesse que rien ne
-- tenait.
--
-- ⚠️ UNE TABLE À NOUS, pas une colonne sur `users`. Le référentiel de l'équipe
-- décrit `users` ; y ajouter notre information en ferait un écart de plus à
-- documenter et à défendre à chaque harmonisation. Même règle que
-- `meeting_rappel` et `meeting_invite_request`.
--
-- La clé primaire EST l'utilisateur : une seule décision courante par compte, et
-- la ré-affirmer écrase la précédente. On ne garde pas d'historique — ce qui
-- compte est l'état actuel, et un journal des refus successifs n'aiderait
-- personne.

CREATE TABLE IF NOT EXISTS geo_consentement (
    user_id   UUID PRIMARY KEY,
    accepte   BOOLEAN NOT NULL,
    decide_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'geo_consentement_user_id_fkey'
    ) THEN
        ALTER TABLE geo_consentement
            ADD CONSTRAINT geo_consentement_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users("alanyaID")
            ON UPDATE CASCADE ON DELETE CASCADE;
    END IF;
END $$;
