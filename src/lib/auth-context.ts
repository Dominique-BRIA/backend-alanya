import { type NextRequest } from "next/server";
import { verifyAccessToken, type TokenPayload } from "./jwt";
import { fail, handleError } from "./http";

export class UnauthorizedError extends Error {
  constructor(message = "Non authentifié") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function extractBearer(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

// Récupère l'utilisateur courant depuis l'access token. Lance UnauthorizedError sinon.
export function requireUser(req: NextRequest): TokenPayload {
  const token = extractBearer(req);
  if (!token) throw new UnauthorizedError("Token manquant");
  try {
    const payload = verifyAccessToken(token);
    if (payload.scope !== "access") throw new UnauthorizedError("Scope de token invalide");
    return payload;
  } catch {
    throw new UnauthorizedError("Token invalide ou expiré");
  }
}

// Enrobe un handler protégé : injecte l'userId et gère proprement les erreurs d'auth.
export function withAuth(
  handler: (req: NextRequest, userId: string, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>,
) {
  return async (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      const { sub } = requireUser(req);
      return await handler(req, sub, ctx);
    } catch (err) {
      if (err instanceof UnauthorizedError) return fail(err.message, 401, "UNAUTHORIZED");
      return handleError(err);
    }
  };
}
