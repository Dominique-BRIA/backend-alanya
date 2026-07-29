-- =============================================================
-- userAccess : index adapté à la lecture de l'historique
-- =============================================================
-- La table n'avait qu'un index sur « dateLogin ». Or la seule requête qui la
-- lit (GET /api/user-access) filtre sur l'utilisateur PUIS trie par date :
--
--   WHERE "alanyaID" = $1 ORDER BY "dateLogin" DESC LIMIT 30
--
-- Avec l'index sur la seule date, PostgreSQL doit parcourir les connexions de
-- TOUS les comptes en écartant celles des autres. Sans conséquence sur une
-- table jeune, coûteux dès qu'un journal s'accumule — et un journal, par
-- nature, ne fait que grossir.
--
-- L'index composite répond directement à la requête : il localise le compte,
-- puis lit les lignes déjà triées.
--
-- Application : psql -h localhost -U alanyavox -d alanya -v ON_ERROR_STOP=1 \
--                    -f prisma/manual/2026-07_user_access_index.sql

CREATE INDEX IF NOT EXISTS "userAccess_alanyaID_dateLogin_idx"
  ON "userAccess"("alanyaID", "dateLogin" DESC);

-- L'ancien index sur la seule date est conservé : il reste utile à une purge
-- par ancienneté (DELETE ... WHERE "dateLogin" < …), qu'il faudra prévoir pour
-- empêcher le journal de croître indéfiniment.
