import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { env } from "@/lib/env";
import { serveursCloudflare, type ServeurIce } from "@/lib/turn-cloudflare";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/*
 * GET /api/calls/ice — les serveurs STUN/TURN d'un appel.
 *
 * 🔴 CLOUDFLARE D'ABORD, NOS RELAIS ENSUITE (03/11/2026, décision du user) :
 *  1. le TURN de Cloudflare, s'il est configuré et répond (`turn-cloudflare.ts`) ;
 *  2. nos relais coturn, toujours présents : `turn.kemita.eu` et
 *     `turn.alanya226.com` — STUN et TURN sur 3478 (UDP et TCP), TURN chiffré
 *     sur 443, qui passe les pare-feu les plus stricts ;
 *  3. le STUN public de Google, en dernier secours.
 *
 * Le téléphone essaie tous ces serveurs EN MÊME TEMPS et garde le premier
 * chemin qui marche : si Cloudflare ne passe pas depuis son réseau, l'appel
 * bascule sur nos relais sans rien attendre.
 *
 * Identifiants de nos relais : le mécanisme standard de coturn — nom
 * `<expiration>:<compte>` valable 24 h, mot de passe = HMAC-SHA1 du nom avec
 * le secret partagé. Rien de permanent ne circule.
 */
function serveursCoturn(userId: string): ServeurIce[] {
  const expiration = Math.floor(Date.now() / 1000) + 24 * 3600;
  const username = `${expiration}:${userId}`;
  const credential = crypto
    .createHmac("sha1", env.coturn.secret())
    .update(username)
    .digest("base64");
  const tls = new Set(env.coturn.tlsDomains());
  const portTls = env.coturn.tlsPort();
  return env.coturn.domains().flatMap((domaine) => [
    { urls: [`stun:${domaine}:3478`] },
    {
      urls: [
        `turn:${domaine}:3478?transport=udp`,
        `turn:${domaine}:3478?transport=tcp`,
        ...(tls.has(domaine) ? [`turns:${domaine}:${portTls}?transport=tcp`] : []),
      ],
      username,
      credential,
    },
  ]);
}

export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  // Borné par le délai de `serveursCloudflare` (3 s) ; un échec rend [] et
  // l'appel part avec nos relais.
  const cloudflare = await serveursCloudflare();
  const iceServers: ServeurIce[] = [
    ...cloudflare,
    ...serveursCoturn(userId),
    { urls: ["stun:stun.l.google.com:19302"] },
  ];

  console.log(
    JSON.stringify({
      action: "ICE_SERVERS_GENERATED",
      timestamp: new Date().toISOString(),
      userId,
      cloudflare: cloudflare.length > 0,
      domains: env.coturn.domains(),
    }),
  );

  return ok({ iceServers });
});
