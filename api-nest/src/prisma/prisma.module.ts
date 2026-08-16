import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

/** Global : un seul pool pour toute l'application (voir PrismaService). */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
