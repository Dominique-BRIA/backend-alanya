import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  compress: false,
  async headers() {
    return [
      {
        // Applique les headers CORS à toutes les routes /api/*
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,PATCH,DELETE,OPTIONS" },
          // Doit rester IDENTIQUE à `CORS_HEADERS` de `src/middleware.ts` :
          // les deux déclarent la même chose à deux niveaux, et une divergence
          // ne se verrait qu'au préflight d'un navigateur. `X-Api-Key` y a été
          // ajouté le 18/08/2026 — sans lui, l'API v1 est inutilisable depuis
          // une page web alors qu'elle documente cet en-tête.
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization, X-Api-Key" },
        ],
      },
    ];
  },
};

export default nextConfig;
