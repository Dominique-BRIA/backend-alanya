-- LE CHIFFREMENT ACTIF PAR DÉFAUT, POUR TOUT LE COMPTE (12/10/2026).
--
-- Décision du user : « par défaut, dans l'application, le chiffrement doit être
-- activé ; si quelqu'un veut, il peut le désactiver pour toute l'application,
-- pas seulement pour une discussion ». Le bouclier qui encombrait l'en-tête de
-- chaque discussion disparaît : les clients chiffrent dès qu'ils le peuvent.
--
-- ⚠️ `DEFAULT true` VAUT AUSSI POUR LES COMPTES EXISTANTS : la colonne est
-- ajoutée avec cette valeur, donc tout le monde est chiffré dès le déploiement,
-- sans migration de données.
--
-- ⚠️ CE RÉGLAGE N'OUVRE RIEN DE CE QUI EST DÉJÀ FERMÉ. Le passer à false
-- n'enlève pas le chiffrement des conversations qui l'ont déjà : il ne fait
-- qu'arrêter d'en chiffrer de nouvelles.
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "chiffrement_actif" BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN "users"."chiffrement_actif" IS
    'Chiffrement de bout en bout pour tout le compte. Défaut : activé.';
