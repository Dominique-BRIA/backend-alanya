import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health/health.controller";
import { PrismaModule } from "./prisma/prisma.module";
import { SelftestController } from "./selftest/selftest.controller";
import { SharedKernelModule } from "./shared-kernel/shared-kernel.module";

/**
 * Racine de l'application.
 *
 * ⚠️ AUCUN module de route métier n'est branché pour l'instant, et c'est
 * voulu : le process doit pouvoir tourner à côté de Next sans servir la
 * moindre route du contrat. Les routes arrivent palier par palier
 * (voir docs/MIGRATION-NESTJS.md, §5).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      // Le .env vit à la racine du dépôt : c'est le même que celui de Next et
      // du serveur WebSocket. Une seule source pour la chaîne de connexion.
      envFilePath: "../.env",
      isGlobal: true,
    }),
    PrismaModule,
    SharedKernelModule,
  ],
  // HealthController et SelftestController sont hors de /api/ : ils n'ajoutent
  // aucune URL au contrat public. Le second disparaît au ticket T20.
  controllers: [HealthController, SelftestController],
})
export class AppModule {}
