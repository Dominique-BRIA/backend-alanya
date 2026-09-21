-- LA ROTATION DES JETONS CESSE DE DECONNECTER LES GENS PAR ACCIDENT.
--
-- 🔴 LE DEFAUT. `rotateRefreshToken` revoque l'ancien jeton et en emet un
-- nouveau. Si le MEME jeton est presente deux fois — reessai apres une reponse
-- perdue, deux requetes concurrentes, un demarrage a froid pendant qu'une
-- notification arrive — la seconde tentative trouve un jeton « revoque » et
-- repond 401. Le client detruit alors la session. L'utilisateur est deconnecte
-- alors que RIEN n'avait expire et qu'il n'a rien fait de mal.
--
-- ⚠️ ON NE PEUT PAS SE CONTENTER DE NE PLUS REVOQUER : la rotation est ce qui
-- protege d'un jeton vole. La reponse standard (OAuth 2.1, « refresh token
-- rotation with reuse detection ») est de garder la rotation ET de distinguer
-- deux rejeux :
--
--   * un rejeu IMMEDIAT, dans la fenetre de grace, est un reessai de bonne foi.
--     On rend un couple neuf, sans rien casser ;
--   * un rejeu TARDIF, alors que le successeur a lui-meme deja tourne, signe
--     une copie du jeton en circulation. La, on coupe toute la chaine.
--
-- Ces deux colonnes portent cette distinction. Sans elles, un jeton revoque ne
-- dit ni QUAND il l'a ete, ni PAR QUOI il a ete remplace : impossible de
-- separer le reessai anodin du vol.

ALTER TABLE "refresh_tokens"
    ADD COLUMN IF NOT EXISTS "rotated_at" TIMESTAMPTZ;

COMMENT ON COLUMN "refresh_tokens"."rotated_at" IS
    'Instant de la rotation ordinaire. NULL = jamais tourne (vivant, expire, ou revoque pour une autre raison).';

-- Le hachage du jeton qui a REMPLACE celui-ci, et non son identifiant : la
-- verification part du jeton presente, donc de son hachage. Chercher par
-- hachage evite une jointure sur le chemin le plus chaud de l'API.
ALTER TABLE "refresh_tokens"
    ADD COLUMN IF NOT EXISTS "remplace_par" VARCHAR(64);

COMMENT ON COLUMN "refresh_tokens"."remplace_par" IS
    'Hachage SHA-256 du jeton emis en echange de celui-ci. Chaine la succession, pour reconnaitre un rejeu tardif.';

-- 🔴 LA CHAINE SE REMONTE A CHAQUE REJEU, ET SANS CET INDEX ELLE BALAIE LA
-- TABLE. `rotateRefreshToken` cherche deja par `token_hash` a chaque
-- rafraichissement — toutes les quinze minutes, pour chaque appareil connecte.
-- La table n'a aujourd'hui d'index que sur l'utilisateur et sur l'appareil.
CREATE INDEX IF NOT EXISTS "refresh_tokens_token_hash_idx"
    ON "refresh_tokens"("tokenHash");

-- ━━ LE MENAGE ━━
--
-- ⚠️ LES LIGNES EXISTANTES RESTENT A `rotated_at` NULL, ET C'EST VOULU. On ne
-- peut pas deviner apres coup laquelle a ete revoquee par rotation et laquelle
-- par eviction — `revoked_reason` ne distingue que l'eviction. Une ligne
-- ancienne rejouee sera donc traitee comme aujourd'hui : refus. Le confort
-- nouveau ne vaut que pour les sessions ouvertes a partir de maintenant, ce qui
-- est atteint en une rotation, soit quinze minutes.
