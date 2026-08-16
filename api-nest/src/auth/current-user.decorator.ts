import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { RequeteAuthentifiee } from "./auth.guard";

/**
 * Injecte l'identifiant de l'utilisateur authentifié — l'équivalent du
 * paramètre `userId` que `withAuth` passait aux handlers Next :
 *
 *   Next : export const GET = withAuth(async (req, userId) => { ... })
 *   Nest : @UseGuards(AuthGuard)
 *          @Get()  lister(@CurrentUser() userId: string) { ... }
 *
 * ⚠️ Inséparable de `@UseGuards(AuthGuard)` : c'est le garde qui renseigne
 * `req.userId`. Sans lui, ce décorateur injecterait `undefined` et la route
 * répondrait des données vides au lieu d'un 401 — une faille silencieuse,
 * jamais une erreur visible. Toujours poser les deux ensemble.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const req = context.switchToHttp().getRequest<RequeteAuthentifiee>();
    const userId = req.userId;
    if (!userId) {
      // Erreur de câblage du développeur, pas une erreur du client.
      throw new Error(
        "@CurrentUser() utilisé sans @UseGuards(AuthGuard) : aucun userId sur la requête",
      );
    }
    return userId;
  },
);
