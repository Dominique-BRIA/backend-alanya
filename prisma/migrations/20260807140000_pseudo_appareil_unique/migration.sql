-- Un pseudo d'appareil est unique AU SEIN d'un compte.
--
-- Le pseudo sert a repondre a « qui, dans l'equipe, a envoye ce message ». Deux
-- postes du meme numero appeles « Accueil » rendraient la reponse inutile.
--
-- L'unicite s'arrete au compte : deux numeros Alanya differents peuvent tres
-- bien avoir chacun leur « Accueil ». Ce sont deux equipes distinctes, elles ne
-- se lisent pas entre elles — c'est pourquoi la contrainte porte sur le couple
-- (compte, pseudo) et non sur le pseudo seul.
--
-- PostgreSQL considere les NULL comme distincts dans un index unique : les
-- appareils sans pseudo restent donc libres, aussi nombreux soient-ils. C'est
-- exactement ce qu'il faut, le pseudo n'etant demande qu'a la premiere
-- connexion d'un compte sur un poste.
--
-- Les doublons deja en base sont ecartes avant la creation de l'index : sans
-- cela, la migration echouerait sur la premiere collision. On ne supprime rien
-- — on vide le pseudo des appareils en trop, et leur utilisateur le redemandera
-- a la prochaine connexion.
UPDATE "Appareil" a
   SET "agent" = NULL
 WHERE "agent" IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM "Appareil" b
      WHERE b."idAgent" = a."idAgent"
        AND b."agent"   = a."agent"
        AND b."appareilID" < a."appareilID"
   );

CREATE UNIQUE INDEX IF NOT EXISTS "Appareil_idAgent_agent_key"
    ON "Appareil"("idAgent", "agent");
