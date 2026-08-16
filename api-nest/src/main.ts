import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";

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
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Le CORS est posé à la main juste en dessous.
    cors: false,
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

  // 3002 : à côté de Next (3000) et du serveur WebSocket (3001). C'est ce
  // port que nginx visera, route par route, pendant la bascule progressive.
  const port = Number(process.env.NEST_PORT ?? 3002);
  await app.listen(port);
  console.log(`[nest] API Alanya à l'écoute sur http://localhost:${port}`);
}

void bootstrap();
