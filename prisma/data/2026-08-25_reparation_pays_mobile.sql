-- =============================================================
-- RÉPARATION DE DONNÉES — pays et numéros de téléphone
-- =============================================================
-- 🔴 CECI EST DE LA DONNÉE, PAS UNE MIGRATION.
--
-- Il vit dans `prisma/data/` et NON dans `prisma/manual/`, qui est rejoué à
-- CHAQUE déploiement. Ce script se joue UNE FOIS, en connaissance de cause.
-- (Il est malgré tout écrit pour être rejouable sans dégât — voir plus bas.)
--
-- ── CE QU'IL RÉPARE ───────────────────────────────────────────────────────
--
-- Les deux clients portaient leur liste de pays codée en dur, avec des
-- identifiants inventés : « 1 = Cameroun » quand la table `pays` dit
-- « 1 = Afrique du Sud ». Tout compte créé depuis ces écrans a donc enregistré
-- un pays faux. Et `users.mobile` a été rempli sans normalisation : la colonne
-- est UNIQUE, mais « 657308298 » et « +237657308299 » ne se ressemblent pas
-- pour PostgreSQL — la même personne peut s'inscrire deux fois et la recherche
-- par numéro n'en trouve qu'une.
--
-- ── CE QU'IL NE FAIT PAS ──────────────────────────────────────────────────
--
-- ⚠️ IL NE DEVINE PAS. Pour beaucoup de comptes, le pays réel n'est plus
-- récupérable : le numéro est absent, ou l'identifiant enregistré est
-- compatible avec plusieurs intentions. Remplacer une valeur fausse par une
-- valeur plausible serait PIRE — elle aurait l'air juste. Ces lignes sont
-- laissées telles quelles et listées en fin de script.
--
-- ── RÉVERSIBILITÉ ─────────────────────────────────────────────────────────
--
-- 🔴 TOUTE LIGNE TOUCHÉE EST D'ABORD COPIÉE dans `reparation_pays_20260825`.
-- C'est ce qui rend ce script acceptable : une correction de données en
-- production sans trace de l'état antérieur ne se défait pas. La table de
-- reprise contient de quoi tout remettre en place, et le SQL du retour arrière
-- est donné en commentaire à la fin.
--
-- Application : psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--                    -f prisma/data/2026-08-25_reparation_pays_mobile.sql

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 0. La table de reprise. Elle garde l'état AVANT, pour chaque ligne touchée.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reparation_pays_20260825 (
  "alanyaID"     UUID PRIMARY KEY,
  alanya_id      VARCHAR(20),
  ancien_idpays  SMALLINT,
  ancien_mobile  VARCHAR(20),
  motif          TEXT,
  repare_le      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Le pays déduit du NUMÉRO, quand celui-ci est international.
--
--    C'est la seule preuve matérielle dont on dispose : un numéro qui commence
--    par « +221 » a été attribué au Sénégal, quel que soit ce que le formulaire
--    a enregistré.
--
--    ⚠️ CORRESPONDANCE LA PLUS LONGUE. « +22 » n'existe pas, mais « +221 » et
--    « +2212 » pourraient coexister : prendre le premier indicatif venu
--    rattacherait le numéro au mauvais pays. `ORDER BY length(prefix) DESC`
--    règle la question une fois pour toutes.
--
--    ⚠️ LES INDICATIFS PARTAGÉS SONT ÉCARTÉS. « +1 » désigne le Canada ET les
--    États-Unis, « +212 » le Maroc ET le Sahara occidental : le numéro ne
--    tranche pas, donc on ne tranche pas non plus.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE deduits_du_numero ON COMMIT DROP AS
WITH indicatifs_uniques AS (
  SELECT prefix, min("idPays") AS "idPays"
    FROM pays
   WHERE prefix <> '' AND "isDelete" = false
   GROUP BY prefix
  HAVING count(*) = 1
)
SELECT u."alanyaID",
       u."alanyaPhone",
       u."idPays" AS ancien_idpays,
       u.mobile   AS ancien_mobile,
       p."idPays" AS bon_idpays
  FROM users u
  JOIN LATERAL (
        SELECT i."idPays"
          FROM indicatifs_uniques i
         WHERE u.mobile LIKE i.prefix || '%'
         ORDER BY length(i.prefix) DESC
         LIMIT 1
       ) p ON true
 WHERE u.mobile LIKE '+%'
   AND u."idPays" IS DISTINCT FROM p."idPays";

INSERT INTO reparation_pays_20260825 ("alanyaID", alanya_id, ancien_idpays, ancien_mobile, motif)
SELECT "alanyaID", "alanyaPhone", ancien_idpays, ancien_mobile,
       'pays deduit de l''indicatif du numero'
  FROM deduits_du_numero
ON CONFLICT ("alanyaID") DO NOTHING;

UPDATE users u
   SET "idPays" = d.bon_idpays
  FROM deduits_du_numero d
 WHERE u."alanyaID" = d."alanyaID";

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Les comptes restés à `idPays = 1`.
--
--    🔴 C'EST LE SEUL ENDROIT OÙ CE SCRIPT S'APPUIE SUR UN RAISONNEMENT PLUTÔT
--    QUE SUR UNE PREUVE. Il est donc borné au maximum, et réversible.
--
--    L'argument : les DEUX listes codées en dur — mobile et web — faisaient
--    correspondre la valeur 1 à « Cameroun ». Personne n'a donc pu choisir
--    « Afrique du Sud » depuis ces écrans, puisqu'ils ne l'affichaient pas à
--    cette place. La valeur 1 en base signifie « cette personne a choisi le
--    Cameroun ».
--
--    ⚠️ RESTREINT AUX NUMÉROS DE FORME CAMEROUNAISE — 9 chiffres commençant
--    par 6, le plan de numérotation mobile du pays. Sans cette borne, on
--    corrigerait aussi les comptes écrits par un client CORRECT (la plateforme
--    de l'équipe partage cette base et peut légitimement enregistrer
--    « 1 = Afrique du Sud »). Les deux indices doivent concorder.
--
--    ⚠️ APRÈS l'étape 1, et c'est voulu : un compte à `idPays = 1` porteur d'un
--    numéro international a déjà été tranché par son indicatif, qui est une
--    preuve plus forte que ce raisonnement.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE presumes_cameroun ON COMMIT DROP AS
SELECT u."alanyaID", u."alanyaPhone", u."idPays" AS ancien_idpays, u.mobile AS ancien_mobile,
       (SELECT "idPays" FROM pays WHERE prefix = '+237' AND "isDelete" = false LIMIT 1) AS bon_idpays
  FROM users u
 WHERE u."idPays" = 1
   AND u.mobile ~ '^6[0-9]{8}$';

INSERT INTO reparation_pays_20260825 ("alanyaID", alanya_id, ancien_idpays, ancien_mobile, motif)
SELECT "alanyaID", "alanyaPhone", ancien_idpays, ancien_mobile,
       'idPays=1 signifiait Cameroun dans les deux listes codees en dur, et le numero suit le plan camerounais'
  FROM presumes_cameroun
ON CONFLICT ("alanyaID") DO NOTHING;

UPDATE users u
   SET "idPays" = p.bon_idpays
  FROM presumes_cameroun p
 WHERE u."alanyaID" = p."alanyaID"
   AND p.bon_idpays IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Normalisation des numéros, avec le pays DÉSORMAIS CORRIGÉ.
--
--    Forme canonique : « + », indicatif, numéro national, sans séparateur —
--    exactement ce que produit `normaliserTelephone` de `src/lib/telephone.mjs`,
--    qui normalise toute écriture nouvelle depuis le 25/08/2026.
--
--    Trois cas, dans cet ordre :
--      a. le numéro porte déjà son indicatif → on ne touche qu'aux séparateurs ;
--      b. il est national → on retire le zéro d'acheminement et on préfixe ;
--      c. le compte n'a pas de pays → ON NE TOUCHE PAS. Sans indicatif, un
--         numéro national ne peut pas être rendu international sans inventer.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE numeros_normalises ON COMMIT DROP AS
SELECT u."alanyaID",
       u."alanyaPhone",
       u."idPays" AS ancien_idpays,
       u.mobile   AS ancien_mobile,
       CASE
         -- (a) déjà international : on ne garde que les chiffres, derrière « + ».
         WHEN u.mobile LIKE '+%'
           THEN '+' || regexp_replace(u.mobile, '[^0-9]', '', 'g')
         -- (b) national : zéro d'acheminement retiré, indicatif du pays ajouté.
         ELSE pa.prefix
              || regexp_replace(
                   regexp_replace(u.mobile, '[^0-9]', '', 'g'),
                   '^0+', '')
       END AS mobile_canonique
  FROM users u
  JOIN pays pa ON pa."idPays" = u."idPays"   -- (c) : la jointure écarte les sans-pays
 WHERE u.mobile IS NOT NULL
   AND u.mobile <> ''
   AND pa.prefix <> '';

INSERT INTO reparation_pays_20260825 ("alanyaID", alanya_id, ancien_idpays, ancien_mobile, motif)
SELECT "alanyaID", "alanyaPhone", ancien_idpays, ancien_mobile, 'numero normalise'
  FROM numeros_normalises
 WHERE mobile_canonique IS DISTINCT FROM ancien_mobile
ON CONFLICT ("alanyaID") DO NOTHING;

/*
 * ⚠️ LA COLONNE EST UNIQUE : normaliser peut faire COLLIDER deux lignes qui
 * portaient jusque-là deux écritures du même numéro. C'est précisément le
 * défaut qu'on répare — mais l'UPDATE échouerait, et tout le script avec.
 *
 * Les collisions sont donc ÉCARTÉES ici et signalées à la fin : fusionner deux
 * comptes n'est pas une opération de nettoyage, c'est une décision qui regarde
 * leurs propriétaires.
 */
UPDATE users u
   SET mobile = n.mobile_canonique
  FROM numeros_normalises n
 WHERE u."alanyaID" = n."alanyaID"
   AND n.mobile_canonique IS DISTINCT FROM n.ancien_mobile
   AND NOT EXISTS (
         SELECT 1 FROM users autre
          WHERE autre.mobile = n.mobile_canonique
            AND autre."alanyaID" <> u."alanyaID"
       );

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Ce qui a été fait, et ce qui reste à décider par un humain.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n_repare   INTEGER;
  n_sans     INTEGER;
  n_collision INTEGER;
BEGIN
  SELECT count(*) INTO n_repare FROM reparation_pays_20260825;
  RAISE NOTICE 'Lignes reparees (sauvegardees dans reparation_pays_20260825) : %', n_repare;

  SELECT count(*) INTO n_sans
    FROM users WHERE mobile IS NOT NULL AND mobile NOT LIKE '+%';
  IF n_sans > 0 THEN
    RAISE NOTICE 'RESTE A DECIDER : % numero(s) sans indicatif — le compte n''a pas de pays, on ne peut pas l''inventer.', n_sans;
  END IF;

  SELECT count(*) INTO n_collision
    FROM numeros_normalises n
   WHERE n.mobile_canonique IS DISTINCT FROM n.ancien_mobile
     AND EXISTS (SELECT 1 FROM users a
                  WHERE a.mobile = n.mobile_canonique
                    AND a."alanyaID" <> n."alanyaID");
  IF n_collision > 0 THEN
    RAISE NOTICE 'RESTE A DECIDER : % numero(s) non normalise(s) car un AUTRE compte porte deja la forme canonique. Fusion a arbitrer.', n_collision;
  END IF;
END $$;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────
-- RETOUR ARRIÈRE, si une correction s'avère fausse :
--
--   UPDATE users u
--      SET "idPays" = r.ancien_idpays,
--          mobile   = r.ancien_mobile
--     FROM reparation_pays_20260825 r
--    WHERE u."alanyaID" = r."alanyaID";
--
-- La table de reprise est CONSERVÉE après le script — ne pas la supprimer sans
-- s'être assuré que les corrections tiennent.
-- ─────────────────────────────────────────────────────────────────────────
