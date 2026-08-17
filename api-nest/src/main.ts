import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { ContractExceptionFilter } from "./common/contract-exception.filter";

/**
 * CORS — réplique EXACTE de src/middleware.ts (le middleware Next).
 *
 * ⚠️ On ne passe PAS par `app.enableCors()`. Le paquet `cors` ne pose
 * `Access-Control-Allow-Methods` et `-Allow-Headers` QUE sur le préflight,
 * alors que le middleware Next les pose sur TOUTES les réponses /api. Les
 * navigateurs ignorent ces deux en-têtes hors préflight, donc la différence
 * serait sans effet fonctionnel — mais elle apparaîtrait dans le harnais de
 * diff de contrat comme un écart à investiguer à chaque route.
 *
 * Reproduire le middleware à l'octet près coûte cinq lignes et supprime le
 * bruit : tout écart détecté par le harnais sera alors un vrai bug.
 */
/*
 * Noms en MINUSCULES, et ce n'est pas un détail de style : Next émet ses
 * en-têtes en minuscules (undici), alors qu'Express préserve la graphie qu'on
 * lui donne. Les noms d'en-têtes HTTP sont insensibles à la casse (RFC 7230),
 * donc aucun client ne voit la différence — mais le harnais de diff de contrat
 * la signalerait sur CHAQUE route comparée. S'aligner coûte zéro et supprime
 * ce bruit. Écart constaté en comparant les deux serveurs le 16/08/2026.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-max-age": "86400",
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Le CORS est posé à la main juste en dessous.
    cors: false,
  });

  /*
   * `content-type: application/json` SANS `; charset=utf-8`.
   *
   * Express ajoute le charset dans `res.json()`, pas Next (`NextResponse.json`
   * envoie `application/json` nu). La différence est inoffensive — JSON est
   * toujours en UTF-8 par la RFC 8259, et tous les clients l'ignorent — mais
   * elle porterait sur les 101 routes, et le harnais de diff la signalerait
   * partout. Écart détecté par le harnais lui-même, le 16/08/2026, avant
   * qu'aucune route ne soit migrée.
   *
   * On intercepte `setHeader` plutôt que `res.json` : Express pose l'en-tête
   * DEPUIS `res.json()`, donc l'écraser après coup n'aurait aucun effet.
   */
  app.use((_req: Request, res: Response, next: NextFunction) => {
    const poserEntete = res.setHeader.bind(res);
    res.setHeader = (nom: string, valeur: number | string | readonly string[]) => {
      if (
        String(nom).toLowerCase() === "content-type" &&
        String(valeur).startsWith("application/json")
      ) {
        return poserEntete(nom, "application/json");
      }
      return poserEntete(nom, valeur);
    };
    next();
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    // Préflight : 204 sans corps, comme Next.
    if (req.method === "OPTIONS") {
      for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
      res.status(204).end();
      return;
    }
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
    next();
  });

  /*
   * Forme d'erreur du contrat, appliquée à TOUTE l'application.
   *
   * Global et non par contrôleur : une seule route qui y échapperait
   * renverrait le `{statusCode, message, error}` de Nest au lieu du
   * `{error:{message,code}}` attendu par les clients. Le défaut doit être le
   * comportement correct, jamais quelque chose à ne pas oublier.
   */
  app.useGlobalFilters(new ContractExceptionFilter());

  /*
   * ⚠️ AUCUN ValidationPipe global, et aucun ClassSerializerInterceptor.
   *
   * Un pipe global de class-validator écraserait la validation Zod des routes
   * (forme du 422). Un intercepteur de sérialisation réécrirait les objets
   * Prisma renvoyés tels quels aujourd'hui — dates, champs nuls, BigInt
   * convertis à la main. Les deux sont des ruptures de contrat silencieuses.
   * La validation se déclare route par route, via ZodValidationPipe.
   */

  // 3002 : à côté de Next (3000) et du serveur WebSocket (3001). C'est ce
  // port que nginx visera, route par route, pendant la bascule progressive.
  const port = Number(process.env.NEST_PORT ?? 3002);
  await app.listen(port);
  console.log(`[nest] API Alanya à l'écoute sur http://localhost:${port}`);
}

void bootstrap();
