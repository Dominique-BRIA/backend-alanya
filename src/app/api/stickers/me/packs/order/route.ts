import { withAuth } from "@/lib/auth-context";
import { ordonnerPacks } from "@/lib/stickers-utilisateur";
import { repondre } from "../../repondre";

/** PUT /api/stickers/me/packs/order — `{ ids }` : l'ordre des packs du panneau. */
export const PUT = withAuth(async (req, userId) => {
  const corps = await req.json().catch(() => null);
  return repondre(() => ordonnerPacks(userId, corps));
});
