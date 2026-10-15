import { type NextRequest } from "next/server";
import { z } from "zod";
import { renouveler } from "@/lib/gestion/session";
import { erreurAdmin, okAdmin, reponseErreurAdmin } from "@/lib/gestion/reponses";

/**
 * POST /api/admin/auth/refresh — `{ refreshToken }` → `{ accessToken, refreshToken }`.
 *
 * 🔴 PAS `/api/auth/refresh`. La console d'origine renouvelait son jeton par la
 * route des UTILISATEURS, qui chez nous est celle de l'application mobile et
 * ne connaît que les jetons mobiles. La console de gestion est retouchée pour
 * appeler celle-ci.
 */
const corpsSchema = z.object({ refreshToken: z.string().min(1) });

export async function POST(req: NextRequest) {
  try {
    const corps = corpsSchema.safeParse(await req.json().catch(() => null));
    if (!corps.success) return erreurAdmin(400, "Jeton de renouvellement requis", "TOKEN_REQUIRED");
    const { accessToken, refreshToken } = await renouveler(corps.data.refreshToken);
    return okAdmin({ accessToken, refreshToken });
  } catch (err) {
    return reponseErreurAdmin(err);
  }
}
