import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { env } from "@/lib/env";

// GET /api/calls/ice — serveurs STUN/TURN pour WebRTC.
export const GET = withAuth(async (_req: NextRequest) => {
  const meteredDomain = process.env.METERED_DOMAIN; 
  const meteredApiKey = process.env.METERED_API_KEY; 

  // 1. Si on a les identifiants Metered, on appelle leur API REST pour récupérer les identifiants dynamiques
  if (meteredDomain && meteredApiKey) {
    try {
      // Nettoie l'URL du domaine au cas où elle inclurait "https://"
      const domainRaw = meteredDomain.replace(/^https?:\/\//, '');
      const response = await fetch(`https://${domainRaw}/api/v1/turn/credentials?apiKey=${meteredApiKey}`);
      if (response.ok) {
        const iceServers = await response.json();
        return ok({ iceServers });
      }
      console.warn("[ICE] Echec de l'API Metered, statut:", response.status);
    } catch (err) {
      console.error("[ICE] Erreur lors de l'appel à Metered API:", err);
    }
  }

  // 2. Fallback statique si Metered échoue ou n'est pas configuré
  return ok({ iceServers: env.webrtc.iceServers() });
});

