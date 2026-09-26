import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * 🔴 LA RACINE DU PROJET, DITE EXPLICITEMENT.
   *
   * 🐛 CONSTATÉ EN PRODUCTION LE 26/09/2026. Next devine sa racine en cherchant
   * un fichier de verrouillage, et il en a trouvé DEUX : celui du projet, et un
   * `package-lock.json` égaré dans le dossier personnel du serveur. Il a choisi
   * le second.
   *
   * Conséquence : il parcourait tout `/home/ubuntu` pour tracer les
   * dépendances, au lieu du seul dossier du projet. La construction le disait —
   * « the whole project was traced unintentionally » — mais c'est le genre
   * d'avertissement qu'on lit comme du bruit. Du temps de construction perdu à
   * chaque déploiement, et des chemins de trace qui ne désignent plus rien de
   * ce qu'on croit.
   *
   * ⚠️ `process.cwd()` EST FIABLE ICI, et pas un pari : `npm run build` s'exécute
   * toujours dans le dossier du paquet, et `deployer.sh` fait `cd "$RACINE"`
   * avant tout le reste. Deviner à partir du disque était le problème ; on
   * arrête de deviner.
   */
  turbopack: { root: process.cwd() },

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
