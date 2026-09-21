-- ════════════════════════════════════════════════════════════════════════
--  CHIFFREMENT — l'enveloppe rejoint son message
--  Créé le 21/09/2026. Suite de `2026-09_e2ee.sql`.
-- ════════════════════════════════════════════════════════════════════════
--
-- 🔴 POURQUOI CE LIEN EXISTE. Une conversation chiffrée ne peut plus ranger son
-- texte dans `message.content` : le serveur n'a pas le droit de le lire. Mais le
-- fil a toujours besoin d'une LIGNE par message — pour l'ordre, l'horodatage,
-- l'expéditeur, le statut, la réponse citée, les mentions.
--
-- On garde donc les deux : la ligne de `message` porte tout SAUF le contenu, et
-- l'enveloppe porte le contenu SANS rien d'autre. Le client rapproche les deux.
--
-- ⚠️ NULLABLE, ET CE N'EST PAS UNE FACILITÉ : une enveloppe peut exister sans
-- message — c'est le cas du banc d'essai, et ce sera celui d'un futur échange de
-- clés hors fil. Rendre la colonne obligatoire interdirait ces usages sans rien
-- protéger de plus.
--
-- ⚠️ `ON DELETE CASCADE` : supprimer un message emporte ses enveloppes. Les
-- laisser derrière ne servirait à personne — elles ne se rattachent à rien, et
-- personne ne peut plus les lire ni les situer dans le fil.

BEGIN;

ALTER TABLE e2ee_enveloppes
  ADD COLUMN IF NOT EXISTS message_id UUID
  REFERENCES message("msgID") ON DELETE CASCADE ON UPDATE CASCADE;

-- La question posée en chargeant un fil : « quelles enveloppes pour ces
-- messages ? ». Partiel, les enveloppes sans message ne concernant pas le fil.
CREATE INDEX IF NOT EXISTS e2ee_enveloppes_message_idx
  ON e2ee_enveloppes(message_id)
  WHERE message_id IS NOT NULL;

COMMIT;
