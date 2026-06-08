import { type NextRequest } from "next/server";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { env } from "@/lib/env";

// GET /api/calls/ice — serveurs STUN/TURN pour WebRTC (configurés via .env).
export const GET = withAuth(async (_req: NextRequest) => {
  return ok({ iceServers: env.webrtc.iceServers() });
});
