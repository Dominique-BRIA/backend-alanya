import { NextResponse, type NextRequest } from "next/server";

// CORS pour permettre à l'app Flutter Web (autre origine) d'appeler l'API.
// On utilise des tokens Bearer (pas de cookies), donc l'origine '*' est acceptable.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
  /*
   * ⚠️ `X-Api-Key` FAIT PARTIE DE LA LISTE, et son absence était bloquante.
   *
   * Un navigateur n'envoie que les en-têtes annoncés ici : une console
   * développeur qui propose « essayer cette requête » — ce que fait tout
   * tableau de bord d'API — échouait au préflight sans le moindre message
   * exploitable, la requête n'atteignant jamais la route.
   *
   * L'API v1 accepte les deux formes (`X-Api-Key` et `Authorization: Bearer
   * ak_…`) : les deux doivent donc être utilisables depuis un navigateur, sinon
   * la moitié de la documentation décrit quelque chose d'impossible.
   */
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  "Access-Control-Max-Age": "86400",
};

export function middleware(req: NextRequest) {
  // Préflight
  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }

  const res = NextResponse.next();
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export const config = {
  matcher: "/api/:path*",
};
