import { PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

/**
 * Validation par Zod — les MÊMES schémas que le backend Next.
 *
 * ⚠️ POURQUOI PAS class-validator, le choix habituel sous Nest (risque R1).
 *
 * Les routes Next valident avec Zod (`src/lib/validation.ts`) et laissent le
 * `ZodError` remonter. `handleError()` le traduit alors en 422 dont le corps
 * contient `details: err.flatten()` — une structure `{formErrors, fieldErrors}`
 * propre à Zod, que les clients reçoivent aujourd'hui.
 *
 * Passer à class-validator produirait un `details` de forme totalement
 * différente : une rupture de contrat sur toutes les routes validées, pour
 * zéro gain. On garde donc Zod, et on réutilise les schémas EXISTANTS sans les
 * réécrire.
 *
 * Ce pipe se contente de valider et de laisser filer le `ZodError` :
 * ContractExceptionFilter s'occupe de la traduction en 422.
 *
 * Usage :
 *   @Post()
 *   creer(@Body(new ZodValidationPipe(monSchema)) corps: MonType) { ... }
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(valeur: unknown): T {
    // `parse` (et non `safeParse`) : on veut que le ZodError soit LEVÉ, pour
    // que le filtre global produise exactement le 422 de Next.
    return this.schema.parse(valeur);
  }
}
