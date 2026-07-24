import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { env } from "@/lib/env";
import crypto from "crypto";

// Forcer Next.js à ne JAMAIS mettre en cache cette route (crucial pour les timestamps dynamiques)
export const dynamic = 'force-dynamic';

// GET /api/calls/ice — Distribution des serveurs Coturn sécurisés par utilisateur
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  try {
    const coturnSecret = env.coturn.secret();
    const coturnDomains = env.coturn.domains();

    // Récupération optionnelle du pseudo / numéro pour les logs
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { pseudo: true, publicNumber: true },
    });
    const usernameLog = userId ?? "anonyme";

    // Paramètres de validité (24 heures)
    const duration = 24 * 3600; 
    const timestamp = Math.floor(Date.now() / 1000) + duration;
    const username = `${timestamp}:${userId}`;

    // Calcul du mot de passe unique (HMAC-SHA1 en Base64)
    const hmac = crypto.createHmac('sha1', coturnSecret);
    hmac.update(username);
    const credential = hmac.digest('base64');

    // Génération de la liste des iceServers : UN SEUL url par entrée, et les
    // identifiants UNIQUEMENT sur les entrées TURN/TURNS (jamais sur STUN).
    // Mélanger stun/turn + credentials dans un même objet casse le TURN sur
    // plusieurs implémentations WebRTC (dont flutter_webrtc).
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      ...coturnDomains.flatMap((domain) => [
        { urls: `stun:${domain}:3478` },
        { urls: `turn:${domain}:3478?transport=udp`, username, credential },
        { urls: `turn:${domain}:3478?transport=tcp`, username, credential },
        { urls: `turns:${domain}:5349?transport=tcp`, username, credential },
      ]),
    ];

    // Log structuré pour le suivi
    console.log(JSON.stringify({
      action: "ICE_SERVERS_GENERATED",
      timestamp: new Date().toISOString(),
      userId,
      username: usernameLog,
      duration: `${duration}s`,
      domains: coturnDomains,
    }));

    return ok({ iceServers });
  } catch (err) {
    console.error("[ICE] Erreur lors de la génération des serveurs ICE:", err);
    
    // Fallback minimal en cas d'erreur de base de données
    const coturnSecret = env.coturn.secret();
    const coturnDomains = env.coturn.domains();
    const fallbackTimestamp = Math.floor(Date.now() / 1000) + 3600;
    const fallbackUsername = `${fallbackTimestamp}:${userId}`;
    const hmac = crypto.createHmac('sha1', coturnSecret);
    hmac.update(fallbackUsername);
    const fallbackCredential = hmac.digest('base64');

    const fallbackIceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      ...coturnDomains.flatMap((domain) => [
        { urls: `stun:${domain}:3478` },
        { urls: `turn:${domain}:3478?transport=udp`, username: fallbackUsername, credential: fallbackCredential },
        { urls: `turn:${domain}:3478?transport=tcp`, username: fallbackUsername, credential: fallbackCredential },
      ]),
    ];

    return ok({ iceServers: fallbackIceServers });
  }
});
