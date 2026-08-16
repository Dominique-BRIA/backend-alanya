import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SharedKernelService } from "../shared-kernel/shared-kernel.service";

/**
 * Point de contrôle interne du process Nest.
 *
 * ⚠️ DÉLIBÉRÉMENT HORS DE `/api/` : cette route n'existe pas dans le backend
 * Next. La placer sous `/api/` ajouterait une URL au contrat public, ce que la
 * migration s'interdit. nginx ne route que `/api/...` vers ce process, donc
 * `/health` reste joignable en local uniquement.
 */
@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kernel: SharedKernelService,
  ) {}

  @Get()
  async check() {
    // Requête volontairement triviale : on vérifie que le pool répond, pas la
    // cohérence des données.
    let base = "ko";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      base = "ok";
    } catch {
      base = "ko";
    }

    // Prouve que le noyau .mjs partagé est bien chargé et appelable — c'est le
    // point le plus fragile du montage (voir SharedKernelService).
    let noyauPartage = "ko";
    try {
      noyauPartage = this.kernel.nomAffichage({ pseudo: "sonde" }) === "sonde" ? "ok" : "ko";
    } catch {
      noyauPartage = "ko";
    }

    return { service: "alanya-api-nest", base, noyauPartage };
  }
}
