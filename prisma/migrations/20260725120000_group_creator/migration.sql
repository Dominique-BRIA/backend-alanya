ALTER TABLE "conversation" ADD COLUMN IF NOT EXISTS "creatorId" UUID;
UPDATE "conversation" c SET "creatorId" = x."userId" FROM (SELECT DISTINCT ON ("convId") "convId", "userId" FROM "conv_participants" ORDER BY "convId", "joinedAt" ASC) x WHERE c."id"=x."convId" AND c."creatorId" IS NULL AND c."isGroup"=true;
UPDATE "conv_participants" p SET "role"='ADMIN' WHERE p."userId"=(SELECT c."creatorId" FROM "conversation" c WHERE c."id"=p."convId") AND p."convId" IN (SELECT "id" FROM "conversation" WHERE "isGroup"=true);
