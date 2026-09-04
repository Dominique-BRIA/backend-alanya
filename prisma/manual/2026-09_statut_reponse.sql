-- Citer un statut dans la conversation où on y répond.
--
-- 🔴 CE QUI MANQUAIT. Répondre à un statut envoyait bien un message privé, mais
-- l'auteur recevait « 😍 » sans savoir à QUOI. Avec trois statuts publiés dans
-- la journée, la réponse devenait une devinette.
--
-- ⚠️ AUCUNE COLONNE AJOUTÉE À `message` NI À `statut`. Les deux appartiennent au
-- référentiel de l'équipe. Et `Message.replyToID` ne pouvait pas servir : sa clé
-- étrangère pointe vers `message`, jamais vers un statut.
--
-- 🔴 C'EST UN INSTANTANÉ, PAS UNE RÉFÉRENCE — la décision qui structure cette
-- table. Un statut est PURGÉ au bout de 24 h (`purgeExpiredStatuses` dans
-- `ws-server.mjs`). Si la citation pointait vers la ligne `statut`, elle
-- disparaîtrait avec elle : le lendemain, la conversation afficherait une
-- réponse à un message manquant. On recopie donc, au moment de la réponse, ce
-- qu'il faut pour redessiner l'aperçu — type, texte, média, couleur de fond.
-- La conversation garde son sens indéfiniment, comme chez WhatsApp.
--
-- CONSÉQUENCE ASSUMÉE : si l'auteur SUPPRIME son statut, l'aperçu déjà envoyé
-- reste dans la conversation. C'est le même comportement qu'un message cité
-- puis supprimé — et c'est cohérent : le destinataire l'avait déjà vu.
--
-- ⚠️ `statutID` N'A VOLONTAIREMENT PAS DE CLÉ ÉTRANGÈRE, pour la raison
-- ci-dessus : la ligne visée est destinée à disparaître. La colonne ne sert
-- qu'à reconnaître deux réponses au même statut.
--
-- UNE LIGNE PAR MESSAGE, d'où la clé primaire sur `msgID` : un message ne cite
-- qu'un seul statut. La règle est portée par la contrainte, pas par du code.
--
-- Rejoué à chaque déploiement par `scripts/apply-manual-sql.sh` : idempotent.

CREATE TABLE IF NOT EXISTS "statut_reponse" (
  "msgID"      UUID NOT NULL,
  "statutID"   UUID NOT NULL,
  "auteurID"   UUID NOT NULL,
  -- Recopiés du statut au moment de la réponse.
  "type"       VARCHAR(10) NOT NULL,
  "texte"      VARCHAR(700),
  "media_url"  TEXT,
  "couleur"    VARCHAR(9),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "statut_reponse_pkey" PRIMARY KEY ("msgID")
);

DO $$
BEGIN
  -- Le message disparaît, sa citation aussi : elle n'a plus rien à décorer.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'statut_reponse_msgID_fkey') THEN
    ALTER TABLE "statut_reponse"
      ADD CONSTRAINT "statut_reponse_msgID_fkey"
      FOREIGN KEY ("msgID") REFERENCES "message"("msgID") ON DELETE CASCADE;
  END IF;

  -- L'auteur du statut, lui, existe toujours — c'est un compte.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'statut_reponse_auteurID_fkey') THEN
    ALTER TABLE "statut_reponse"
      ADD CONSTRAINT "statut_reponse_auteurID_fkey"
      FOREIGN KEY ("auteurID") REFERENCES "users"("alanyaID") ON DELETE CASCADE;
  END IF;
END
$$;
