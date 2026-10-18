-- NOM VERROUILLÉ (18/10/2026).
--
-- Demande du patron : chacun peut donner le nom qu'il veut à un contact (le
-- nom s'affiche alors partout chez lui : messages, appels, notifications).
-- Mais un compte peut choisir de s'y opposer : « ceux qui m'enregistrent sont
-- obligés d'utiliser le nom qui est déjà là ».
--
-- Faux par défaut : rien ne change pour les comptes existants. Vrai : le
-- serveur ignore PARTOUT les noms donnés à ce compte (ils restent en base, et
-- reviennent si le compte rouvre la possibilité), et refuse d'en poser un.
ALTER TABLE "users"
    ADD COLUMN IF NOT EXISTS "nom_verrouille" BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN "users"."nom_verrouille" IS
    'Vrai : les autres ne peuvent pas renommer ce compte dans leur répertoire.';
