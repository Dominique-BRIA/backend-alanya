-- =============================================================
-- LA LANGUE DE CHAQUE COMPTE (24/10/2026)
-- =============================================================
-- La bienvenue et les diffusions de la console se rédigent en plusieurs
-- langues (fr, en, zh, comme chez Alanya2026) : il faut savoir laquelle
-- envoyer à chacun. C'est celle que l'application déclare dans
-- `Accept-Language` — la langue CHOISIE DANS L'APPLICATION, mémorisée à
-- l'inscription, à la connexion et à chaque lecture du profil.
--
-- NULL tant que le compte ne s'est pas manifesté : il reçoit alors le repli
-- (anglais, puis français), comme une langue non couverte.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "langue" VARCHAR(10);
