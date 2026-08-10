-- Lot Réunions — rappel 5 minutes avant le début.
-- Migration ADDITIVE et NON DESTRUCTIVE (CREATE TABLE uniquement).
--
-- Une ligne = un rappel DÉJÀ ENVOYÉ pour cette réunion. Sa seule existence
-- porte l'information ; il n'y a pas de colonne « envoyé oui/non » à tenir.
--
-- Pourquoi une table à nous plutôt qu'une colonne sur `meeting` : `meeting` et
-- `participant` viennent du référentiel de l'équipe. Y ajouter une colonne
-- créerait un écart de plus à documenter et à défendre, pour une information
-- qui ne les concerne pas.
--
-- La clé primaire EST l'identifiant de la réunion : deux instances du serveur
-- qui balaieraient en même temps ne peuvent pas envoyer deux rappels, la
-- seconde insertion échoue. C'est cette contrainte, et non un verrou applicatif,
-- qui garantit l'unicité.

CREATE TABLE IF NOT EXISTS meeting_rappel (
  "idMeeting" integer     PRIMARY KEY,
  "envoyeA"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_rappel_meeting_fk
    FOREIGN KEY ("idMeeting") REFERENCES meeting("idMeeting") ON DELETE CASCADE
);
