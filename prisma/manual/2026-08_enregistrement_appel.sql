-- Enregistrement des conversations agent ↔ client d'un centre d'appels.
--
-- ⚠️ REJOUÉ À CHAQUE DÉPLOIEMENT par `scripts/apply-manual-sql.sh` : tout doit
-- être idempotent.
--
-- L'AUTORISATION vit ailleurs : `center.enregistrement`, posée par
-- `2026-08_plainte_vocale.sql`. Cette table-ci ne stocke que les enregistrements
-- effectivement produits.
--
-- 🔴 DEUX FICHIERS, PUIS UN TROISIÈME. Le greffon `flutter_webrtc` ne sait
-- enregistrer QU'UN côté à la fois — vérifié dans son code Android
-- (`GetUserMediaImpl.startRecordingToFile` choisit `inputSamplesInterceptor` OU
-- `outputSamplesInterceptor`, jamais les deux). Le téléphone envoie donc deux
-- pistes séparées, et le serveur les mélange. C'est ce qui évite de maintenir
-- un fork du greffon, sur une dépendance critique dont chaque montée de version
-- deviendrait un chantier.

CREATE TABLE IF NOT EXISTS call_recording (
  "idRecording"     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idCompany"       integer NOT NULL,
  -- L'appel enregistré. `SET NULL` et non `CASCADE` : une purge des appels ne
  -- doit pas emporter des enregistrements que l'entreprise doit conserver.
  "call_id"         uuid,
  -- L'agent, c'est-à-dire celui dont `center.enregistrement` valait vrai.
  "agent_alanyaID"  uuid,
  -- Le correspondant. Nullable pour la même raison que l'auteur d'une plainte :
  -- un compte supprimé ne doit pas effacer la trace.
  "client_alanyaID" uuid,

  -- Les DEUX pistes brutes, telles que le téléphone les a envoyées.
  --
  -- ⚠️ CONSERVÉES même après le mélange, et ce n'est pas du gaspillage : c'est
  -- la seule façon de refaire le mélange si ffmpeg change de version ou si le
  -- résultat est mauvais. Les effacer ferait de la première tentative la
  -- dernière.
  "media_agent_id"  uuid NOT NULL,
  "media_client_id" uuid NOT NULL,

  -- Le fichier MÉLANGÉ. Nul tant que le mélange n'a pas eu lieu — état normal,
  -- pas une panne : ffmpeg peut être absent du serveur, et l'enregistrement
  -- reste alors exploitable en deux pistes.
  "media_mix_id"    uuid,

  "duree_ms"        integer NOT NULL DEFAULT 0,
  -- 0 = pistes reçues, à mélanger · 1 = mélange en cours · 2 = mélangé
  -- 3 = mélange impossible (les deux pistes restent là).
  "statut"          smallint NOT NULL DEFAULT 0,
  -- Même rôle que pour une plainte : rend l'envoi idempotent PAR CONSTRUCTION.
  "cle_envoi"       varchar(64) NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT call_recording_company_fk
    FOREIGN KEY ("idCompany") REFERENCES company(idcompany)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT call_recording_call_fk
    FOREIGN KEY ("call_id") REFERENCES calls(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT call_recording_agent_fk
    FOREIGN KEY ("agent_alanyaID") REFERENCES users("alanyaID")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT call_recording_client_fk
    FOREIGN KEY ("client_alanyaID") REFERENCES users("alanyaID")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT call_recording_media_agent_fk
    FOREIGN KEY ("media_agent_id") REFERENCES media_files(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT call_recording_media_client_fk
    FOREIGN KEY ("media_client_id") REFERENCES media_files(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- ⚠️ `SET NULL` ici, et `CASCADE` sur les deux pistes brutes. Effacer le
  -- mélange doit pouvoir se faire pour le REFAIRE ; effacer une piste brute,
  -- en revanche, rend l'enregistrement irréparable.
  CONSTRAINT call_recording_media_mix_fk
    FOREIGN KEY ("media_mix_id") REFERENCES media_files(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT call_recording_statut_ck
    CHECK ("statut" BETWEEN 0 AND 3)
);

CREATE UNIQUE INDEX IF NOT EXISTS call_recording_cle_envoi_key
  ON call_recording ("cle_envoi");

-- « Les enregistrements de cet agent, les plus récents d'abord » : la requête
-- d'un écran d'entreprise.
CREATE INDEX IF NOT EXISTS call_recording_agent_date_idx
  ON call_recording ("agent_alanyaID", "created_at" DESC);

CREATE INDEX IF NOT EXISTS call_recording_company_idx
  ON call_recording ("idCompany");

-- Ce qui reste à mélanger. Index PARTIEL : il ne porte que les lignes en
-- attente, donc il reste minuscule même quand la table grossit, et c'est
-- exactement la question que pose le mélangeur à chaque passage.
CREATE INDEX IF NOT EXISTS call_recording_a_melanger_idx
  ON call_recording ("created_at")
  WHERE "statut" = 0;

-- ── L'URL ABSOLUE du mélange, lisible sans jeton ────────────────────────────
--
-- Décision du user (21/08/2026), en réponse à la question n° 4 de la note
-- d'équipe du 20/08, qui la laissait explicitement ouverte. Même modèle que
-- `voice_complaint.url_audio` : la plateforme lit la table DIRECTEMENT, comme
-- elle le fait déjà pour `center_music` et `center_audio`, et y trouve une
-- adresse prête à l'emploi plutôt que d'intégrer notre mécanisme de jetons.
--
-- 🔴 ELLE NE PORTE QUE LE MÉLANGE, et elle est posée par la MÊME requête que
-- `statut = 2` : une adresse présente est donc une adresse qui répond. Les deux
-- pistes brutes n'ont pas d'URL publique et ne doivent pas en avoir — chacune ne
-- contient qu'UNE voix, elles ne sont conservées que pour refaire le mélange.
--
-- ⚠️ **CETTE URL N'EST PAS UN CONTRÔLE D'ACCÈS**, et l'enjeu est plus grand que
-- pour une plainte : c'est une CONVERSATION ENTIÈRE, à deux voix, dont le
-- correspondant n'a jamais été averti qu'elle était enregistrée. Quiconque la
-- connaît l'écoute. Elle est rendue INDEVINABLE — elle porte l'UUID de
-- l'enregistrement, tiré au hasard — ce qui reste de l'obscurité, pas une
-- autorisation.
ALTER TABLE call_recording
  ADD COLUMN IF NOT EXISTS url_audio varchar(500);

COMMENT ON COLUMN call_recording.url_audio IS
  'URL absolue du melange, lisible SANS jeton. Ecrite avec statut=2 : presente => jouable.';
