import { Global, Module } from "@nestjs/common";
import { SharedKernelService } from "./shared-kernel.service";

/** Global : le noyau .mjs n'est chargé qu'une fois, au démarrage. */
@Global()
@Module({
  providers: [SharedKernelService],
  exports: [SharedKernelService],
})
export class SharedKernelModule {}
