-- Portée du répertoire des collègues, entreprise par entreprise.
--
-- 🔴 QUI VOIT QUI, DANS L'ONGLET « COLLÈGUES » :
--    0 = un agent ne voit que les collègues de SON PROPRE SERVICE ;
--    1 = un agent voit tous les services de SON ENTREPRISE.
--
-- Demandé par le user le 27/08/2026. Le champ devait être créé depuis la
-- plateforme de l'équipe ; il ne l'était pas.
--
-- ⚠️ DÉFAUT À 1, ET C'EST DÉLIBÉRÉ. C'est le comportement d'aujourd'hui : toute
-- entreprise déjà en base continue de fonctionner exactement pareil après cette
-- migration. Un défaut à 0 aurait, au premier déploiement, coupé sans
-- prévenir la vue de chaque agent de chaque entreprise — un changement que
-- personne n'a demandé, et dont personne n'aurait compris la cause.
--
-- ⚠️ LA BORNE PAR ENTREPRISE N'EST PAS DANS CE CHAMP. Elle est déjà partout
-- dans `src/lib/collegues.ts` : le répertoire n'a JAMAIS montré autre chose que
-- sa propre entreprise. Ce réglage ne fait que resserrer au service.
--
-- Idempotent : rejoué à chaque déploiement par `scripts/apply-manual-sql.sh`.

ALTER TABLE company
  ADD COLUMN IF NOT EXISTS collegue smallint NOT NULL DEFAULT 1;

COMMENT ON COLUMN company.collegue IS
  'Onglet Collegues : 0 = uniquement son propre service, 1 = tous les services de l entreprise.';

-- Le champ n'accepte que deux valeurs, et c'est la BASE qui le tient.
--
-- Sans cette contrainte, un « 2 » saisi depuis la plateforme de l'équipe
-- passerait, et le serveur le lirait comme « different de 0 », donc comme 1 :
-- un reglage silencieusement faux vaut moins qu'une erreur a l'ecriture.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_collegue_check'
  ) THEN
    ALTER TABLE company
      ADD CONSTRAINT company_collegue_check CHECK (collegue IN (0, 1));
  END IF;
END $$;
