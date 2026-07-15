import { type NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { env } from "@/lib/env";
import { registerPushToken, unregisterPushToken } from "@/lib/push";

const schema = z.object({
  token: z.string().min(1).max(512),
  platform: z.enum(["android", "ios", "web"]),
});

// POST /api/push/register — enregistre un jeton FCM pour l'utilisateur connecté (v2).
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  try {
    if (!env.push.enabled()) {
      return fail("Notifications push désactivées (v2)", 503, "PUSH_DISABLED");
    }
    const { token, platform } = schema.parse(await req.json());
    await registerPushToken(userId, token, platform);
    return ok({ registered: true });
  } catch (err) {
    return handleError(err);
  }
});

// DELETE /api/push/register — retire un jeton (déconnexion / désinstallation).
export const DELETE = withAuth(async (req: NextRequest, userId: string) => {
  try {
    if (!env.push.enabled()) {
      return fail("Notifications push désactivées (v2)", 503, "PUSH_DISABLED");
    }
    const token = req.nextUrl.searchParams.get("token");
    if (!token) return fail("Paramètre token requis", 400, "BAD_REQUEST");
    await unregisterPushToken(userId, token);
    return ok({ removed: true });
  } catch (err) {
    return handleError(err);
  }
});
