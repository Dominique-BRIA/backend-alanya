-- Plaintes vocales des centres vocaux, et autorisation d'enregistrement.
--
-- ⚠️ REJOUÉ À CHAQUE DÉPLOIEMENT par `scripts/apply-manual-sql.sh` : tout doit
-- être idempotent, et rester vrai sur une base déjà migrée comme sur une base
-- neuve.
--
-- 🔴 SONDAGE FAIT AVANT ÉCRITURE (19/08/2026) : aucune colonne ni table portant
-- `record`, `enregistr`, `complain` ou `plaint` n'existait dans toute la base.
-- Contrairement à `vocal`, `company.url_serveur` et `center.nom_service`, la
-- collègue n'avait rien posé ici.

-- ── 1. Autorisation d'enregistrement, par agent ET par centre ────────────────
--
-- ⚠️ COLONNE AJOUTÉE À UNE TABLE DU RÉFÉRENTIEL ÉQUIPE — choix explicite du
-- user, contre la règle habituelle du projet (« une information à nous se met
-- dans une table à nous »). C'est un écart de plus à défendre à la prochaine
-- harmonisation, et une colonne que la plateforme de la collègue peut effacer
-- si elle recrée `center`. Assumé, mais à ne pas oublier.
--
-- Aucune table de liaison à créer : une ligne de `center` EST déjà le triplet
-- (centre, touche, agent). La configuration est donc nativement individuelle
-- par agent, et modifier un centre n'atteint aucun autre.
--
-- ⚠️ `ADD COLUMN IF NOT EXISTS` NE VÉRIFIE PAS LE TYPE : si la colonne existe
-- déjà avec un autre type, elle est sautée EN SILENCE. Le contrôle de type est
-- fait à part, après ce fichier, sur `information_schema.columns`.
ALTER TABLE center
  ADD COLUMN IF NOT EXISTS enregistrement boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN center.enregistrement IS
  'Cet agent est-il autorise a enregistrer ses conversations avec un client ? Pose par Alanya, absent du referentiel equipe.';

-- ── Le bip d'enregistrement N'EST PAS EN BASE ───────────────────────────────
--
-- Décision du user (19/08/2026) : la collègue téléverse le fichier sur SON
-- serveur et en donne le lien, que nous rangeons dans une VARIABLE
-- D'ENVIRONNEMENT — `BIP_ENREGISTREMENT_URL`, lue par `src/lib/ivr.mjs`.
--
-- Une colonne `company.url_bip_enregistrement` avait été posée puis RETIRÉE :
-- ne pas la réintroduire. Le son est le même pour toute la plateforme, il ne se
-- règle pas par entreprise, et une variable évite une troisième colonne à nous
-- dans une table du référentiel équipe. Précédent identique : `VOCAL_BASE_URL`.

-- ── 2. Plaintes vocales ─────────────────────────────────────────────────────
--
-- Le FICHIER n'entre jamais en base : seule sa référence y figure, comme pour
-- tous les médias du produit. `media_id` pointe **`media_files`**, qui porte
-- déjà le stockage, le type MIME et la durée — inutile de refaire ce travail.
--
-- ⚠️ TROIS NOMS QUI NE SE DEVINENT PAS, relevés dans `information_schema` avant
-- d'écrire ce fichier — les supposer aurait fait échouer les trois clés :
--   * la table des médias s'appelle `media_files`, pas `media` ;
--   * la clé primaire de `users` est `"alanyaID"`, pas `id` ;
--   * celle de `company` est `idcompany` en MINUSCULES, alors que
--     `center_audio` porte `"idCompany"` en camelCase. Les deux graphies
--     coexistent dans cette base ; il faut citer chacune telle qu'elle est.
CREATE TABLE IF NOT EXISTS voice_complaint (
  "idComplaint"     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idCompany"       integer NOT NULL,
  -- Le centre vocal appelé. On garde son identifiant de COMPTE, pas son
  -- numéro : le numéro peut être reformaté, l'identifiant non.
  "center_alanyaID" uuid NOT NULL,
  -- L'appelant. NULLABLE À DESSEIN : un compte supprimé ne doit pas emporter
  -- la plainte, qui est une trace destinée à l'entreprise et non à lui.
  "user_id"         uuid,
  "media_id"        uuid NOT NULL,
  -- Redondante avec `media`, et c'est voulu : c'est la seule mesure qu'un
  -- écran de tri a besoin de lire sans joindre, et elle doit survivre à une
  -- purge des médias.
  "duree_ms"        integer NOT NULL DEFAULT 0,
  -- 0 = reçue, 1 = en cours de traitement, 2 = traitée, 3 = rejetée.
  -- Un entier et non une enum : le référentiel équipe code tous ses statuts
  -- ainsi (`meeting.status`, `users.type_compte`), et une enum PostgreSQL se
  -- migre bien plus mal.
  "statut"          smallint NOT NULL DEFAULT 0,
  -- 🔴 CE QUI REND L'ENVOI IDEMPOTENT. Le client pose une clé par
  -- enregistrement ; deux envois du même fichier — réseau qui hésite, double
  -- appui, réessai — ne peuvent pas produire deux plaintes. La règle est tenue
  -- par une CONTRAINTE et non par du code : c'est la seule forme qu'un
  -- contournement ne peut pas défaire.
  "cle_envoi"       varchar(64) NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT voice_complaint_company_fk
    FOREIGN KEY ("idCompany") REFERENCES company(idcompany)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT voice_complaint_center_fk
    FOREIGN KEY ("center_alanyaID") REFERENCES users("alanyaID")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT voice_complaint_user_fk
    FOREIGN KEY ("user_id") REFERENCES users("alanyaID")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT voice_complaint_media_fk
    FOREIGN KEY ("media_id") REFERENCES media_files(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT voice_complaint_statut_ck
    CHECK ("statut" BETWEEN 0 AND 3)
);

-- L'unicité de la clé d'envoi est GLOBALE et non par centre : la clé est un
-- UUID posé par le client, elle ne peut pas se répéter d'un centre à l'autre,
-- et une unicité globale attrape aussi le cas où le client se tromperait de
-- destinataire entre deux tentatives.
CREATE UNIQUE INDEX IF NOT EXISTS voice_complaint_cle_envoi_key
  ON voice_complaint ("cle_envoi");

-- Le tri d'un écran d'entreprise : « les plaintes de ce centre, les plus
-- récentes d'abord ». L'index porte les deux colonnes dans cet ordre parce que
-- c'est exactement la requête, et non deux index séparés.
CREATE INDEX IF NOT EXISTS voice_complaint_centre_date_idx
  ON voice_complaint ("center_alanyaID", "created_at" DESC);

CREATE INDEX IF NOT EXISTS voice_complaint_company_idx
  ON voice_complaint ("idCompany");
