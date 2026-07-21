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
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
        ],
      },
    ];
  },
};

export default nextConfig;
