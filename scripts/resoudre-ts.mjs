/**
 * Laisse Node charger les modules TypeScript du dépôt importés SANS
 * extension (« ./lecture-page »), comme le fait Next. Sert aux bancs d'essai
 * lancés directement par Node :
 *
 *   node --import ./scripts/resoudre-ts.mjs scripts/recherche-web-banc.ts
 */
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (erreur) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw erreur;
    }
  },
});
