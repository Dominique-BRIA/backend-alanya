-- Codes de vérification — table `verification`.
--
-- 🔴 REMPLACE `developer_otps`, qui ne peut pas garder une double
-- authentification. Ce que l'ancienne table rendait IMPOSSIBLE, et pas
-- seulement difficile :
--
--   * `code` était stocké EN CLAIR. Depuis que le backend du tableau de bord
--     partage cette base, tout code en cours de validité y était lisible par un
--     second système.
--   * il n'existait AUCUNE colonne de tentatives. Six chiffres, cinq minutes,
--     essais illimités : le second facteur ne résistait pas à une boucle.
--   * aucune finalité, donc une seule politique pour un code de connexion et
--     pour une confirmation d'adresse.
--   * aucun état de livraison : la route répondait « envoyé avec succès » alors
--     que rien ne partait quand le destinataire n'avait pas Alanya.
--
-- La table ci-dessous ne stocke QUE l'empreinte du code. Une fuite de base ne
-- donne donc plus aucun code utilisable — c'est la seule propriété qui survit à
-- la compromission d'un des deux systèmes qui lisent cette base.

CREATE TABLE IF NOT EXISTS "verification" (
  "id_verification"  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "developer_id"     UUID         NOT NULL,

  -- À quoi sert ce code. Porte SA politique (durée, essais, plafonds) :
  -- voir `src/lib/verification/politique.mjs`, qui en est la référence.
  "finalite"         VARCHAR(30)  NOT NULL,

  -- Qui livre : `ALANYA` (nous) ou `DELEGUE` (l'appelant, par e-mail ou autre).
  "canal"            VARCHAR(20)  NOT NULL,

  -- Numéro ou adresse, tel qu'il a été demandé.
  "destination"      VARCHAR(120) NOT NULL,

  /*
   * ⚠️ L'EMPREINTE, JAMAIS LE CODE. Sel par ligne : sans lui, un code à six
   * chiffres se retrouve par table arc-en-ciel en une fraction de seconde,
   * l'espace n'ayant qu'un million d'entrées. Le sel rend chaque empreinte
   * unique même pour deux codes identiques, ce qui oblige à attaquer chaque
   * ligne séparément.
   */
  "code_empreinte"   CHAR(64)     NOT NULL,
  "code_sel"         CHAR(32)     NOT NULL,

  "tentatives"       SMALLINT     NOT NULL DEFAULT 0,
  "max_tentatives"   SMALLINT     NOT NULL,

  "expire_a"         TIMESTAMPTZ  NOT NULL,
  -- Usage unique : renseignée à la première présentation réussie.
  "consomme_a"       TIMESTAMPTZ,

  -- Ce qui s'est RÉELLEMENT passé à la remise. Jamais supposé.
  "livraison"        VARCHAR(20)  NOT NULL DEFAULT 'EN_ATTENTE',
  "livraison_detail" VARCHAR(255),

  -- Source de la demande, pour le plafond par IP. Nullable : un appel
  -- serveur à serveur derrière un relais peut ne pas en fournir.
  "ip_demande"       INET,

  "created_at"       TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_developer_fkey') THEN
    ALTER TABLE "verification"
      ADD CONSTRAINT "verification_developer_fkey"
      FOREIGN KEY ("developer_id") REFERENCES "developer_accounts" ("developer_id")
      ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;

  -- Les bornes portées par la BASE, pas seulement par le code : une écriture
  -- directe — et il y en aura, deux systèmes partagent cette base — ne peut pas
  -- fabriquer un code éternel ni un plafond d'essais absent.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_tentatives_bornes') THEN
    ALTER TABLE "verification"
      ADD CONSTRAINT "verification_tentatives_bornes"
      CHECK ("tentatives" >= 0 AND "max_tentatives" BETWEEN 1 AND 10 AND "tentatives" <= "max_tentatives");
  END IF;

  -- `EMAIL` et non `DELEGUE` : nous livrons dans les deux cas, le code brut ne
  -- figure dans AUCUNE réponse d'API. Un canal délégué aurait fait dépendre la
  -- sécurité de la journalisation d'un système tiers.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_canal_connu') THEN
    ALTER TABLE "verification"
      ADD CONSTRAINT "verification_canal_connu"
      CHECK ("canal" IN ('ALANYA', 'EMAIL'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'verification_livraison_connue') THEN
    ALTER TABLE "verification"
      ADD CONSTRAINT "verification_livraison_connue"
      CHECK ("livraison" IN ('EN_ATTENTE', 'REMIS', 'ECHEC', 'REMPLACE'));
  END IF;
END $$;

-- Plafond par destination : « combien de codes pour ce numéro depuis une
-- heure ». Sans cet index, le contrôle balaierait la table à chaque envoi.
CREATE INDEX IF NOT EXISTS "verification_destination_date_idx"
  ON "verification" ("destination", "created_at" DESC);

-- Plafond par source.
CREATE INDEX IF NOT EXISTS "verification_ip_date_idx"
  ON "verification" ("ip_demande", "created_at" DESC);

-- Recherche du code en cours pour une destination donnée, et journal par compte.
CREATE INDEX IF NOT EXISTS "verification_developer_date_idx"
  ON "verification" ("developer_id", "created_at" DESC);

/*
 * 🔴 UN SEUL CODE VIVANT À LA FOIS, par destination et par finalité — et c'est
 * une CONTRAINTE, pas une intention.
 *
 * L'ancienne table ne remplaçait rien : `/send` ajoutait une ligne, et la
 * vérification acceptait n'importe quel code encore valide pour ce numéro.
 * Demander 100 codes en rendait donc 100 valables simultanément, faisant passer
 * la chance d'un tirage au hasard de 1 sur 1 000 000 à 1 sur 10 000 —
 * **redemander un code affaiblissait la protection au lieu de la renforcer.**
 *
 * L'index partiel ne porte que sur les codes ENCORE VIVANTS (non consommés) :
 * l'historique reste intact et consultable, seule la coexistence est interdite.
 * Le service invalide l'ancien avant d'insérer le nouveau ; cet index est ce
 * qui rend l'oubli impossible, y compris depuis une écriture directe du second
 * système qui partage cette base.
 */
CREATE UNIQUE INDEX IF NOT EXISTS "verification_un_seul_vivant_idx"
  ON "verification" ("destination", "finalite")
  WHERE "consomme_a" IS NULL AND "livraison" <> 'REMPLACE';
