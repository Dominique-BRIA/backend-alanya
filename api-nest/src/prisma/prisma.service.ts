import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Client Prisma de l'application Nest.
 *
 * ⚠️ MÊME schema.prisma, MÊME client généré, AUCUNE migration. Le schéma
 * appartient au backend Next existant et n'est pas touché par la migration :
 * `npm run prisma:generate` pointe explicitement sur ../prisma/schema.prisma.
 *
 * ⚠️ POOL DE CONNEXIONS — pendant la bascule, Next et Nest tournent EN MÊME
 * TEMPS et ouvrent donc DEUX pools sur la même base. La production a déjà été
 * mesurée à 106 connexions pour un `max_connections` de 100 (risque R3 du plan
 * de migration). Le nombre de connexions se règle par la chaîne de connexion,
 * pas ici : ajouter `?connection_limit=5` à DATABASE_URL pour ce process.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      // Même politique de logs que src/lib/prisma.ts côté Next.
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log("Connecté à PostgreSQL");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
