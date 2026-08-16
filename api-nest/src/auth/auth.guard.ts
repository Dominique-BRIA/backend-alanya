import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { ContractUnauthorized } from "../common/contract.exception";

export type TokenScope = "access" | "refresh" | "setup";

export interface TokenPayload {
  /** userId */
  sub: string;
  scope: TokenScope;
}

/** Requête enrichie de l'utilisateur authentifié (voir CurrentUser). */
export interface RequeteAuthentifiee extends Request {
  userId?: string;
}

/**
 * Équivalent de `withAuth` / `requireUser` (`src/lib/auth-context.ts`).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI UNE RÉIMPLÉMENTATION, ET NON UN IMPORT DE src/lib/jwt.ts
 *
 * `jwt.ts` est du TypeScript vivant dans le projet Next. L'inclure dans la
 * compilation de Nest ferait remonter la racine du programme d'un cran, et
 * `dist/main.js` deviendrait `dist/api-nest/src/main.js` — cassant à la fois
 * `nest build` et le calcul de chemin du noyau .mjs partagé.
 *
 * La duplication est assumée pour trois raisons :
 *  - la surface est minuscule : lire un en-tête, vérifier une signature ;
 *  - elle EXISTE DÉJÀ dans le projet — `ws-server.mjs` fait son propre
 *    `jwt.verify()` en ligne, avec le même secret. On suit l'architecture en
 *    place, on ne l'enfreint pas ;
 *  - Next disparaît en fin de migration : la fenêtre de divergence est bornée.
 *
 * Ce qui garantit l'identité de comportement, c'est le SECRET PARTAGÉ
 * (`JWT_ACCESS_SECRET`, même .env) et les options par défaut de `jsonwebtoken`,
 * pas le partage du fichier.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ BIZARRERIE RÉPLIQUÉE VOLONTAIREMENT — ne pas « corriger ».
 *
 * Dans `requireUser`, le `throw new UnauthorizedError("Scope de token
 * invalide")` est écrit À L'INTÉRIEUR du `try`, donc immédiatement rattrapé
 * par le `catch` nu qui le remplace par « Token invalide ou expiré ». Ce
 * message n'est donc JAMAIS observable par un client.
 *
 * Les deux seules réponses possibles aujourd'hui sont :
 *   - en-tête Bearer absent      → « Token manquant »
 *   - jeton invalide, expiré,
 *     ou de mauvais scope        → « Token invalide ou expiré »
 *
 * Rendre le message de scope visible ici serait une amélioration — et une
 * rupture de contrat. À corriger, si souhaité, APRÈS la migration.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RequeteAuthentifiee>();

    const token = this.extraireBearer(req);
    if (!token) throw new ContractUnauthorized("Token manquant");

    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      // Panne de configuration, pas un refus d'authentification : un 401 ici
      // ferait croire à un problème de jeton et enverrait tout le monde se
      // reconnecter en boucle.
      throw new Error("Variable d'environnement manquante : JWT_ACCESS_SECRET");
    }

    try {
      const payload = jwt.verify(token, secret) as TokenPayload;
      // Même garde que Next. Le message ci-dessous n'est jamais celui que voit
      // le client : le catch l'uniformise, exactement comme l'original.
      if (payload.scope !== "access") throw new Error("Scope de token invalide");
      req.userId = payload.sub;
      return true;
    } catch {
      throw new ContractUnauthorized("Token invalide ou expiré");
    }
  }

  /** Identique à `extractBearer` : préfixe exact, puis `trim()`. */
  private extraireBearer(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length).trim();
  }
}
