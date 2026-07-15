import { type NextRequest } from "next/server";
import { ok, fail, handleError } from "@/lib/http";
import { refreshSchema } from "@/lib/validation";
import { rotateRefreshToken } from "@/modules/auth/tokens";

// POST /api/auth/refresh
// Échange un refresh token valide contre un nouveau couple access/refresh (avec rotation).
export async function POST(req: NextRequest) {
  try {
    const { refreshToken } = refreshSchema.parse(await req.json());
    try {
      const tokens = await rotateRefreshToken(refreshToken);
      return ok(tokens);
    } catch {
      return fail("Refresh token invalide ou expiré", 401, "BAD_REFRESH");
    }
  } catch (err) {
    return handleError(err);
  }
}
