import { Controller, Get, HttpCode, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import { ContractException } from "../common/contract.exception";
import { ZodValidationPipe } from "../common/zod-validation.pipe";

/**
 * Banc d'essai du SOCLE CONTRACTUEL — pas une fonctionnalité produit.
 *
 * Chaque route déclenche volontairement un cas que le socle doit traduire
 * exactement comme le backend Next : erreur métier, validation Zod, 401,
 * exception Nest interne, code HTTP explicite. Elles permettent de vérifier le
 * socle AVANT qu'une seule route du contrat ne soit migrée — sinon on ne le
 * découvre qu'en cassant une vraie route.
 *
 * ⚠️ DÉLIBÉRÉMENT HORS DE `/api/` : ces URL n'existent pas dans le contrat, et
 * nginx ne route que `/api/...` vers ce process. Elles restent donc
 * inaccessibles depuis l'extérieur.
 *
 * 🗑️ À SUPPRIMER au ticket T20 (nettoyage final), quand le socle aura fait ses
 * preuves sur les 101 routes.
 */
@Controller("_selftest")
export class SelftestController {
  /** Erreur métier avec code : doit donner {error:{message,code}}. */
  @Get("erreur-metier")
  erreurMetier(): never {
    throw new ContractException(404, "Ressource introuvable", "NOT_FOUND");
  }

  /**
   * Erreur métier SANS code : la clé `code` doit être ABSENTE du JSON, et non
   * présente à `null`. C'est la subtilité la plus facile à rater.
   */
  @Get("erreur-sans-code")
  erreurSansCode(): never {
    throw new ContractException(400, "Requête invalide");
  }

  /** Validation Zod : doit donner un 422 avec `details` au format flatten(). */
  @Get("validation")
  validation(
    @Query(new ZodValidationPipe(z.object({ age: z.coerce.number().int().min(18) })))
    query: { age: number },
  ) {
    return { age: query.age };
  }

  /** Erreur JS quelconque : doit donner un 400 portant le message brut. */
  @Get("erreur-generique")
  erreurGenerique(): never {
    throw new Error("Quelque chose a mal tourné");
  }

  /** Route protégée : 401 sans jeton, userId injecté avec un jeton valide. */
  @Get("protege")
  @UseGuards(AuthGuard)
  protege(@CurrentUser() userId: string) {
    return { userId };
  }

  /**
   * POST renvoyant 200 et NON 201.
   *
   * ⚠️ Nest répond 201 par défaut sur POST, là où la plupart des routes Next
   * renvoient 200 via `ok(data)`. Sans `@HttpCode(200)` explicite, chaque POST
   * migré changerait de code HTTP — le piège le plus systématique de toute la
   * migration (risque R1).
   */
  @Post("post-200")
  @HttpCode(200)
  post200() {
    return { ok: true };
  }

  /** POST renvoyant réellement 201, comme `ok(data, 201)` côté Next. */
  @Post("post-201")
  post201() {
    return { cree: true };
  }
}
