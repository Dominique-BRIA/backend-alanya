-- ════════════════════════════════════════════════════════════════════════
--  CHIFFREMENT — la mémoire d'un refus de sauvegarde
--  Créé le 23/09/2026. Lot 3 de `docs/PLAN-E2EE.md`.
-- ════════════════════════════════════════════════════════════════════════
--
-- 🔴 POURQUOI CETTE COLONNE EXISTE. La sauvegarde chiffrée s'active D'ELLE-MÊME
-- à la première connexion — décision du user, 23/09/2026 : « c'est plus
-- intuitif ». Sans mémoire d'un refus, quelqu'un qui la désactive la verrait
-- revenir à la connexion suivante.
--
-- Ce ne serait pas une maladresse d'affichage : ce serait passer outre une
-- décision explicite de quelqu'un sur ses propres données, en silence, et de
-- façon répétée.
--
-- ⚠️ SUR LE COMPTE, PAS SUR L'APPAREIL. Le refus suit la personne. Le ranger
-- localement le ferait oublier au premier navigateur neuf — c'est-à-dire
-- exactement dans le cas où la réactivation silencieuse se produirait.
--
-- ⚠️ `DEFAULT false` : les comptes existants n'ont rien refusé. Ils verront la
-- sauvegarde s'activer à leur prochaine connexion, comme les nouveaux.
--
-- Produit par `prisma migrate diff`, filtré sur cette table.

BEGIN;

ALTER TABLE "users" ADD COLUMN "e2ee_sauvegarde_refusee" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
