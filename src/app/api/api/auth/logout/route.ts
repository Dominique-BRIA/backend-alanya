import { type NextRequest } from "next/server";
import { ok, handleError } from "@/lib/http";
import { refreshSchema } from "@/lib/validation";
import { revokeRefreshToken } from "@/modules/auth/tokens";

// POST /api/auth/logout
// Révoque le refresh token fourni.
export async function POST(req: NextRequest) {
  try {
    const { refreshToken } = refreshSchema.parse(await req.json());
    await revokeRefreshToken(refreshToken);
    return ok({ message: "Déconnecté" });
  } catch (err) {
    return handleError(err);
  }
}
