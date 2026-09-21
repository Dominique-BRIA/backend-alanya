-- ════════════════════════════════════════════════════════════════════════
--  CHIFFREMENT DE BOUT EN BOUT — le socle serveur (protocole Signal)
--  Créé le 21/09/2026. Branche `feat/e2ee`, DÉVELOPPEMENT UNIQUEMENT.
-- ════════════════════════════════════════════════════════════════════════
--
-- 🔴 CE QUE LE SERVEUR PEUT VOIR, ET CE QU'IL NE DOIT JAMAIS VOIR.
--
-- Tout ce qui est rangé ici est PUBLIC par construction : des clés publiques,
-- et des messages déjà chiffrés. Le serveur ne détient AUCUN secret permettant
-- de lire quoi que ce soit — c'est la définition même du bout en bout, et la
-- seule propriété qui compte pour juger ce schéma.
--
-- Ce qui reste chez le client, et n'a pas de table ici :
--   * les clés privées (identité, pré-clés, éphémères) ;
--   * l'état des sessions du Double Ratchet — clé racine, clés de chaîne,
--     numéros de message, clés sautées. Le spec du Double Ratchet n'a AUCUN
--     composant serveur : c'est du client à client, de bout en bout.
--
-- ⚠️ SI UN JOUR UNE COLONNE DE CE FICHIER PORTE UNE CLÉ PRIVÉE, LE CHIFFREMENT
-- N'EXISTE PLUS. Ce n'est pas une précaution de style : un serveur qui détient
-- de quoi déchiffrer est exactement ce que le bout en bout écarte.
--
-- ────────────────────────────────────────────────────────────────────────
-- LE MODÈLE, EN DEUX TEMPS (X3DH puis Double Ratchet)
--
-- 1. Chaque APPAREIL publie ici un jeu de clés publiques :
--      · une clé d'identité, permanente ;
--      · une pré-clé SIGNÉE, renouvelée régulièrement, dont la signature par
--        la clé d'identité prouve qu'elle vient bien du même appareil ;
--      · un stock de pré-clés À USAGE UNIQUE, consommées une par une.
--
-- 2. Qui veut écrire récupère ce « paquet de pré-clés » et calcule le secret
--    partagé SANS que le destinataire soit connecté — c'est tout l'objet de
--    X3DH, et la raison d'être du stock d'usage unique. Le serveur ne fait que
--    servir des clés publiques et transporter des enveloppes closes.
--
-- ⚠️ LE CHIFFREMENT EST PAR APPAREIL, PAS PAR COMPTE. Un compte ouvert sur un
-- téléphone et un navigateur a DEUX identités distinctes, et un message leur
-- est chiffré DEUX fois. Ranger les clés au niveau du compte rendrait le
-- déchiffrement impossible sur le second appareil — c'est l'erreur de
-- conception qui coûte le plus cher ici, parce qu'elle ne se voit qu'à
-- l'usage, quand un appareil ne lit plus rien.

-- ⚠️ CE FICHIER EST ALIGNE SUR CE QUE PRISMA ATTEND, AU DETAIL PRES, et c'est
-- `prisma migrate diff` qui en juge — pas la lecture. Trois points ne se
-- devinent pas :
--   · les UUID sont generes par le CLIENT (`@default(uuid())`), donc AUCUN
--     `DEFAULT gen_random_uuid()` en base, si tentant soit-il ;
--   · Prisma pose `ON UPDATE CASCADE` sur toutes ses cles etrangeres ;
--   · ses index sont croissants, meme quand un DESC serait plus naturel.
--
-- Un ecart sur l'un des trois ne casse rien tout de suite : il rend la base
-- differente de ce que le code croit, et la difference ressort des mois plus
-- tard, sur une migration qui refuse de passer.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
--  1. L'IDENTITÉ D'UN APPAREIL
-- ════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS e2ee_identites (
  id               UUID PRIMARY KEY,

  -- Le compte propriétaire. CASCADE : un compte supprimé emporte ses clés,
  -- qui ne veulent plus rien dire sans lui.
  "alanyaID"       UUID NOT NULL
                   REFERENCES users("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE,

  -- ⚠️ L'APPAREIL, AU SENS DU PROTOCOLE, ET NON `appareils.appareilID`.
  --
  -- C'est le client qui le choisit et le garde : il survit à une ligne du
  -- registre d'appareils, qui elle se recrée à chaque vidage de cache. Lier les
  -- deux ferait perdre l'identité — donc toutes les conversations — au premier
  -- nettoyage de navigateur.
  device_id        INTEGER NOT NULL,

  -- Le « registration id » de Signal : un entier tiré au sort à l'installation,
  -- qui distingue deux installations d'un même appareil. Il voyage dans les
  -- paquets de pré-clés.
  registration_id  INTEGER NOT NULL,

  -- La clé publique d'identité, permanente (Curve25519), en base64.
  --
  -- ⚠️ ELLE NE CHANGE JAMAIS SANS CONSÉQUENCE : c'est sur elle que repose la
  -- vérification de sécurité entre deux personnes. Un changement doit être
  -- VISIBLE des correspondants, jamais silencieux — sans quoi un serveur qui
  -- la remplacerait s'interposerait sans que personne ne le sache.
  cle_identite     TEXT NOT NULL,

  create_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ⚠️ SANS DEFAUT, contrairement a `create_at` juste au-dessus : Prisma tient
  -- `@updatedAt` lui-meme, cote client, et n'attend donc rien en base. La
  -- dissymetrie surprend a la lecture, elle est pourtant exacte.
  update_at        TIMESTAMPTZ NOT NULL,

  -- Un seul jeu de clés par appareil et par compte.
  CONSTRAINT e2ee_identites_compte_appareil UNIQUE ("alanyaID", device_id)
);

CREATE INDEX IF NOT EXISTS e2ee_identites_compte_idx
  ON e2ee_identites("alanyaID");

-- ════════════════════════════════════════════════════════════════════════
--  2. LA PRÉ-CLÉ SIGNÉE
-- ════════════════════════════════════════════════════════════════════════
--
-- Renouvelée régulièrement. On GARDE l'ancienne un temps : un correspondant
-- peut avoir récupéré le paquet juste avant la rotation et écrire une minute
-- après. Supprimer aussitôt rendrait ce message indéchiffrable — un message
-- perdu sans que rien ne l'explique.
CREATE TABLE IF NOT EXISTS e2ee_prekeys_signees (
  id            UUID PRIMARY KEY,
  identite_id   UUID NOT NULL
                REFERENCES e2ee_identites(id) ON DELETE CASCADE ON UPDATE CASCADE,

  -- Identifiant choisi par le client ; il voyage dans le message pour dire
  -- LAQUELLE des pré-clés a servi.
  prekey_id     INTEGER NOT NULL,
  cle_publique  TEXT NOT NULL,

  -- La signature de `cle_publique` par la clé d'identité.
  --
  -- 🔴 C'EST ELLE QUI EMPÊCHE LE SERVEUR DE S'INTERPOSER. Sans signature, il
  -- suffirait de servir une pré-clé fabriquée pour lire tout ce qui suit. Le
  -- client DOIT la vérifier contre la clé d'identité avant d'ouvrir la
  -- moindre session — la ranger sans la vérifier ne protège de rien.
  signature     TEXT NOT NULL,

  create_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT e2ee_prekeys_signees_unique UNIQUE (identite_id, prekey_id)
);

CREATE INDEX IF NOT EXISTS e2ee_prekeys_signees_identite_idx
  ON e2ee_prekeys_signees(identite_id, create_at);

-- ════════════════════════════════════════════════════════════════════════
--  3. LES PRÉ-CLÉS À USAGE UNIQUE
-- ════════════════════════════════════════════════════════════════════════
--
-- 🔴 « À USAGE UNIQUE » EST UNE PROPRIÉTÉ DE SÉCURITÉ, PAS UNE COMMODITÉ.
-- Servir deux fois la même détruit la confidentialité persistante de la
-- première session. La consommation passe donc par une mise à jour
-- conditionnelle atomique (`WHERE consomme_le IS NULL`), jamais par un
-- « lire puis écrire » que deux requêtes simultanées franchiraient ensemble.
--
-- ⚠️ ON MARQUE AU LIEU DE SUPPRIMER : une pré-clé consommée reste visible le
-- temps qu'on sache qu'elle l'a été, et le client peut se réapprovisionner en
-- comptant ce qui reste. La purge est une tâche d'entretien, pas la
-- consommation elle-même.
CREATE TABLE IF NOT EXISTS e2ee_prekeys_uniques (
  id            UUID PRIMARY KEY,
  identite_id   UUID NOT NULL
                REFERENCES e2ee_identites(id) ON DELETE CASCADE ON UPDATE CASCADE,
  prekey_id     INTEGER NOT NULL,
  cle_publique  TEXT NOT NULL,
  create_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consomme_le   TIMESTAMPTZ,

  CONSTRAINT e2ee_prekeys_uniques_unique UNIQUE (identite_id, prekey_id)
);

-- Index PARTIEL sur les seules pré-clés encore libres : c'est la seule
-- question qu'on pose à cette table — « donne-m'en une qui n'a pas servi ».
CREATE INDEX IF NOT EXISTS e2ee_prekeys_uniques_libres_idx
  ON e2ee_prekeys_uniques(identite_id, create_at)
  WHERE consomme_le IS NULL;

-- ════════════════════════════════════════════════════════════════════════
--  4. LES ENVELOPPES CHIFFRÉES
-- ════════════════════════════════════════════════════════════════════════
--
-- 🔴 UNE ENVELOPPE PAR APPAREIL DESTINATAIRE, et c'est la conséquence directe
-- du chiffrement par appareil. Un message à quelqu'un qui a trois appareils
-- produit TROIS enveloppes, chacune illisible par les deux autres.
--
-- ⚠️ TABLE SÉPARÉE DE `messages`, VOLONTAIREMENT. La table des messages porte
-- du texte en clair et tout l'historique existant ; y greffer le chiffré
-- mélangerait deux régimes dans les mêmes colonnes, et la moindre requête
-- oubliée exposerait l'un en croyant lire l'autre. Deux tables, deux régimes,
-- aucune confusion possible.
CREATE TABLE IF NOT EXISTS e2ee_enveloppes (
  id                UUID PRIMARY KEY,

  -- ⚠️ La clé primaire des conversations s'appelle `conversID` en base, pas
  -- `conversationID` : c'est le référentiel équipe, et le deviner coûte une
  -- migration qui échoue à la dernière ligne. La TABLE, elle, est au SINGULIER
  -- (`conversation`) quand celle des comptes est au pluriel (`users`) — deux
  -- conventions dans la même base, dont aucune ne se devine.
  conversation_id   UUID NOT NULL
                    REFERENCES conversation("conversID") ON DELETE CASCADE ON UPDATE CASCADE,

  -- Qui écrit, et depuis quel appareil : le destinataire en a besoin pour
  -- retrouver la bonne session.
  expediteur_id     UUID NOT NULL
                    REFERENCES users("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE,
  expediteur_device INTEGER NOT NULL,

  -- À qui, et vers quel appareil.
  destinataire_id   UUID NOT NULL
                    REFERENCES users("alanyaID") ON DELETE CASCADE ON UPDATE CASCADE,
  destinataire_device INTEGER NOT NULL,

  -- 1 = PreKeyWhisperMessage (ouvre la session), 3 = WhisperMessage (session
  -- déjà établie). Ce sont les valeurs du protocole, reprises telles quelles
  -- plutôt que renommées : elles voyagent jusqu'à la bibliothèque du client,
  -- qui ne connaît que celles-là.
  type              SMALLINT NOT NULL,

  -- Le message chiffré, en base64. Opaque pour le serveur, et il doit le
  -- rester.
  corps             TEXT NOT NULL,

  create_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Remise : l'enveloppe est retirée une fois lue par son appareil.
  remis_le          TIMESTAMPTZ
);

-- La question posée à chaque relève : « qu'est-ce qui m'attend, moi, sur cet
-- appareil ? ». Index partiel, pour la même raison que plus haut.
CREATE INDEX IF NOT EXISTS e2ee_enveloppes_attente_idx
  ON e2ee_enveloppes(destinataire_id, destinataire_device, create_at)
  WHERE remis_le IS NULL;

CREATE INDEX IF NOT EXISTS e2ee_enveloppes_conv_idx
  ON e2ee_enveloppes(conversation_id, create_at);

-- ════════════════════════════════════════════════════════════════════════
--  5. LE DRAPEAU DE CONVERSATION
-- ════════════════════════════════════════════════════════════════════════
--
-- ⚠️ ADDITIF ET PAR DÉFAUT FAUX : tout l'existant continue exactement comme
-- avant. Rien ne bascule tant que personne ne l'a demandé, ce qui est la seule
-- façon d'introduire ceci sans risquer l'historique.
ALTER TABLE conversation
  ADD COLUMN IF NOT EXISTS e2ee_actif BOOLEAN NOT NULL DEFAULT false;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
--  CONTRÔLE — zéro ligne attendue
-- ════════════════════════════════════════════════════════════════════════
-- SELECT 'TABLE MANQUANTE : ' || t
-- FROM unnest(ARRAY['e2ee_identites','e2ee_prekeys_signees',
--                   'e2ee_prekeys_uniques','e2ee_enveloppes']) t
-- WHERE NOT EXISTS (SELECT 1 FROM information_schema.tables
--                   WHERE table_name = t);
