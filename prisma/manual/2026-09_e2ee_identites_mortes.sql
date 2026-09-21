-- ════════════════════════════════════════════════════════════════════════
--  CHIFFREMENT — savoir quelles identités vivent encore
--  Créé le 21/09/2026. Suite de `2026-09_e2ee.sql`.
-- ════════════════════════════════════════════════════════════════════════
--
-- 🔴 LE PROBLÈME DES IDENTITÉS MORTES.
--
-- Chaque appareil publie une identité. RIEN ne la retire. Qui vide le cache de
-- son navigateur ou réinstalle l'application en crée une neuve — et l'ancienne
-- reste publiée, pour toujours.
--
-- Les correspondants récupèrent TOUTES les identités d'un compte et chiffrent
-- pour chacune. Après cinq réinstallations, chaque message part en six
-- exemplaires dont cinq ne seront JAMAIS lus. Chacun consomme une pré-clé, et
-- les enveloppes s'entassent sans que personne ne les relève.
--
-- ⚠️ CE N'EST PAS UN DÉFAUT DU PROTOCOLE : c'est ce qui arrive quand personne
-- ne fait le ménage. Signal retire l'identité à la déconnexion et balaie les
-- inactives ; nous ne faisions ni l'un ni l'autre.
--
-- ⚠️ ON NE PEUT PAS « RECONNAÎTRE » L'APPAREIL POUR RÉUTILISER SON IDENTITÉ.
-- Une identité EST sa clé privée : si la clé a disparu avec le cache, aucune
-- empreinte de navigateur ne la ressuscite. Reconnaître l'appareil et lui
-- rendre son ancienne identité publique sans la clé privée donnerait un
-- appareil incapable de déchiffrer ce qu'on lui envoie — exactement le défaut
-- qu'on cherche à corriger, en pire, puisqu'il paraîtrait vivant.
--
-- La seule issue est donc le MÉNAGE, et il demande de savoir qui relève encore.

BEGIN;

ALTER TABLE e2ee_identites
  ADD COLUMN IF NOT EXISTS derniere_releve TIMESTAMPTZ;

-- Les identités déjà là sont considérées actives à partir de maintenant : les
-- déclarer mortes d'office couperait des appareils parfaitement vivants qui
-- n'ont simplement pas encore relevé depuis cette migration.
UPDATE e2ee_identites SET derniere_releve = now() WHERE derniere_releve IS NULL;

-- La question du balayage : « qui n'a pas relevé depuis longtemps ? »
CREATE INDEX IF NOT EXISTS e2ee_identites_releve_idx
  ON e2ee_identites(derniere_releve);

COMMIT;
