-- ════════════════════════════════════════════════════════════════════════
--  CHIFFREMENT — une serrure « trousseau » PAR APPAREIL
--  Créé le 24/09/2026. Préparation du lot 4 (client mobile).
-- ════════════════════════════════════════════════════════════════════════
--
-- 🐛 LE DÉFAUT QUE CETTE MIGRATION CORRIGE.
--
-- `UNIQUE (alanyaID, type)` traitait les trois serrures de la même façon. C'est
-- juste pour deux d'entre elles — un mot de passe et une clé de récupération
-- suivent la PERSONNE, et reposer la même doit remplacer l'ancienne.
--
-- Mais `trousseau` n'est pas de cette nature : il appartient à UN APPAREIL.
-- Face ID sur le téléphone et Windows Hello sur le portable sont deux secrets
-- différents, et les deux doivent ouvrir l'archive.
--
-- Avec l'ancienne contrainte, poser le trousseau sur un second appareil
-- EFFAÇAIT celui du premier, qui cessait alors de s'ouvrir tout seul — sans que
-- rien ne le signale. Invisible tant qu'il n'y avait qu'un client web ;
-- bloquant dès l'arrivée du mobile.
--
-- ⚠️ CHAÎNE VIDE PLUTÔT QUE NULL. Dans PostgreSQL, deux NULL ne se heurtent pas
-- dans un index unique : une serrure « mot de passe » à NULL aurait donc pu
-- être posée deux fois, c'est-à-dire exactement ce que l'unicité empêchait.
--
-- 🔴 LA CONTRAINTE `CHECK` PORTE LA RÈGLE, PAS SEULEMENT LE CODE. Sans elle,
-- rien n'empêcherait une serrure « mot de passe » attachée à un appareil (donc
-- posable deux fois) ni un trousseau sans appareil (donc unique par compte, et
-- on serait revenu au défaut). Une règle qu'aucune contrainte ne porte finit
-- par être contournée par un chemin qu'on n'avait pas prévu.
--
-- Migration SANS PERTE : les serrures existantes reçoivent `appareil = ''`,
-- ce qui correspond à leur sens actuel pour `motdepasse` et `recuperation`.
--
-- ⚠️ LES TROUSSEAUX DÉJÀ POSÉS SONT SUPPRIMÉS, et c'est volontaire : ils ne
-- désignent aucun appareil, donc la contrainte les refuserait. Il n'y en a
-- qu'en développement, et leur propriétaire n'a qu'à reposer la serrure. Les
-- laisser en les rattachant à un appareil arbitraire serait pire : une serrure
-- qui prétend appartenir à un appareil qui ne peut pas l'ouvrir.

-- ⚠️ REJOUABLE, ET CE N'EST PAS FACULTATIF. `deployer.sh` applique TOUS les
-- fichiers de ce dossier à CHAQUE déploiement : un script qui échoue la
-- seconde fois arrête la mise en ligne. Tout est donc en IF NOT EXISTS,
-- contraintes comprises.
BEGIN;

ALTER TABLE "e2ee_serrures"
  ADD COLUMN IF NOT EXISTS "appareil" VARCHAR(64) NOT NULL DEFAULT '';

-- Voir plus haut : un trousseau sans appareil n'a pas de sens.
-- 🔴 SEULEMENT CELLES QUI NE DÉSIGNENT AUCUN APPAREIL, jamais toutes.
--
-- 🐛 CE FILTRE MANQUAIT. Le script étant rejoué à CHAQUE déploiement, un
-- DELETE sans condition aurait détruit la serrure « trousseau » de TOUS les
-- appareils, à chaque mise en ligne — en silence, et sans que personne ne
-- fasse le lien avec un déploiement.
--
-- Avec ce filtre, la première exécution retire les serrures héritées — qui ne
-- peuvent pas satisfaire la nouvelle contrainte — et les suivantes ne trouvent
-- plus rien.
DELETE FROM "e2ee_serrures" WHERE "type" = 'trousseau' AND "appareil" = '';

DROP INDEX IF EXISTS "e2ee_serrures_compte_type_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "e2ee_serrures_compte_type_appareil_uniq"
  ON "e2ee_serrures" ("alanyaID", "type", "appareil");

-- La règle, portée par la base et non par la seule bonne volonté du client.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'e2ee_serrures_appareil_selon_type') THEN
    ALTER TABLE "e2ee_serrures" ADD CONSTRAINT "e2ee_serrures_appareil_selon_type"
  CHECK (
    ("type" = 'trousseau' AND "appareil" <> '')
    OR ("type" IN ('motdepasse', 'recuperation') AND "appareil" = '')
  );
  END IF;
END $$;

COMMIT;
