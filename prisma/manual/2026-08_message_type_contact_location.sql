-- `MessageType.CONTACT` et `MessageType.LOCATION` — partage d'une fiche de
-- contact et d'une position GPS dans une discussion (demande user 17/08/2026,
-- expérience visée : celle de WhatsApp).
--
-- Choix arrêté par le user : de VRAIS types de message, et non un message TEXT
-- déguisé. La charge utile, elle, reste dans `content` au format JSON (voir
-- `src/lib/message-payload.mjs`) : aucune colonne n'est ajoutée à `message`,
-- qui est une table du référentiel de l'équipe.
--
-- ⚠️ `ADD VALUE` sur un enum ne peut pas tourner dans une transaction avant
-- PostgreSQL 12, et la valeur ajoutée n'est pas utilisable dans la même
-- transaction que son ajout. La prod est en 18.4 (vérifié), donc
-- `IF NOT EXISTS` passe et ce fichier est rejouable à chaque déploiement.
--
-- ⚠️ Les deux valeurs sont ajoutées EN FIN d'enum, dans cet ordre, pour rester
-- alignées sur `schema.prisma` : Prisma compare les listes de valeurs, et un
-- ordre divergent fait apparaître un écart au `migrate diff`.
--
-- Aucune ligne existante n'est touchée : ces types n'ont jamais été écrits.

ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'CONTACT';
ALTER TYPE "MessageType" ADD VALUE IF NOT EXISTS 'LOCATION';
