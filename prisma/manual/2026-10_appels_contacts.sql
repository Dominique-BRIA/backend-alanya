-- CONTACTS PRÉFÉRÉS UNIQUEMENT (29/10/2026).
--
-- Demande du user : « lorsqu'il est activé dans les paramètres, seuls mes
-- contacts enregistrés peuvent m'appeler ». Un appel direct d'un compte qui
-- n'est pas dans mes contacts (preferredContact) est refusé avant de sonner.
--
-- Faux par défaut : rien ne change pour les comptes existants.
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "appels_contacts_seulement" BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN "users"."appels_contacts_seulement" IS
    'Vrai : seuls les contacts enregistrés de ce compte peuvent l''appeler.';
