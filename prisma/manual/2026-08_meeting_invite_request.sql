-- Lot Réunions — demandes d'invitation soumises à l'organisateur.
-- Migration ADDITIVE et NON DESTRUCTIVE (CREATE TABLE / INDEX uniquement).
--
-- Un participant peut proposer d'ajouter quelqu'un ; l'organisateur tranche.
-- Tant qu'il n'a pas tranché, la personne proposée n'existe pas pour la
-- réunion — elle n'est PAS dans `participant`, et elle n'apprend rien.
--
-- statut : 0 = en attente, 1 = acceptée, 2 = refusée.
--
-- ⚠️ L'UNICITÉ PORTE SUR (idMeeting, invite) ET NON SUR LE DEMANDEUR, et c'est
-- ce qui applique la règle « un refus est définitif ». La ligne refusée reste
-- en base et bloque toute nouvelle demande concernant cette personne, quel que
-- soit celui qui la formule. Sans cette contrainte, un participant refusé
-- n'aurait qu'à faire redemander par un collègue.
--
-- Table à nous : `meeting` et `participant` viennent du référentiel de
-- l'équipe, et rien de tout ceci ne les concerne.

CREATE TABLE IF NOT EXISTS meeting_invite_request (
  id          serial      PRIMARY KEY,
  "idMeeting" integer     NOT NULL,
  demandeur   uuid        NOT NULL,
  invite      uuid        NOT NULL,
  statut      smallint    NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  CONSTRAINT meeting_invite_request_meeting_fk
    FOREIGN KEY ("idMeeting") REFERENCES meeting("idMeeting")  ON DELETE CASCADE,
  CONSTRAINT meeting_invite_request_demandeur_fk
    FOREIGN KEY (demandeur)   REFERENCES users("alanyaID")     ON DELETE CASCADE,
  CONSTRAINT meeting_invite_request_invite_fk
    FOREIGN KEY (invite)      REFERENCES users("alanyaID")     ON DELETE CASCADE,
  CONSTRAINT meeting_invite_request_unique UNIQUE ("idMeeting", invite)
);

-- Le seul accès fréquent : « les demandes en attente de cette réunion ».
CREATE INDEX IF NOT EXISTS meeting_invite_request_meeting_statut_idx
  ON meeting_invite_request ("idMeeting", statut);
