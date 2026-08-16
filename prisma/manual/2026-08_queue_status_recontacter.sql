-- `QueueStatus.RECONTACTER` — un client abandonné a été rappelé par un agent
-- et il a DÉCROCHÉ (demande user 15/08/2026). Distinct de MIS_EN_RELATION,
-- qui décrit un appel abouti à l'initiative du client ; ici c'est le centre
-- qui a repris contact. Sert aussi à le retirer de la liste « à rappeler »,
-- filtrée sur ABANDON/TIMEOUT/REJETE.
--
-- ⚠️ `ADD VALUE` sur un type enum ne peut PAS tourner dans une transaction
-- avant PostgreSQL 12, et la valeur ajoutée n'est pas utilisable dans la même
-- transaction que son ajout. Vérifié : la prod est en 18.4, donc
-- `IF NOT EXISTS` passe. Rien à réécrire sur les lignes existantes.

ALTER TYPE "QueueStatus" ADD VALUE IF NOT EXISTS 'RECONTACTER';
