// Fichier : src/app/api/calls/ice/route.ts
import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { env } from "@/lib/env";

export const GET = withAuth(async (_req: NextRequest) => {
  const meteredDomain = process.env.METERED_DOMAIN; 
  const meteredApiKey = process.env.METERED_API_KEY; 

  // 1. Si on a tes identifiants Metered, on appelle leur API REST
  if (meteredDomain && meteredApiKey) {
    try {
      const response = await fetch(`https://${meteredDomain}/api/v1/turn/credentials?apiKey=${meteredApiKey}`);
      if (response.ok) {
        const iceServers = await response.json();
        // Renvoie directement le format généré par Metered à ton Frontend
        return ok({ iceServers });
      }
    } catch (err) {
      console.error("[ICE] Erreur lors de l'appel à Metered API:", err);
    }
  }

  // 2. Fallback (si ça échoue, ça utilise l'ancienne méthode)
  return ok({ iceServers: env.webrtc.iceServers() });
});
