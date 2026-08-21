import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail, handleError } from "@/lib/http";
import { requireUser, UnauthorizedError } from "@/lib/auth-context";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl } from "@/lib/avatar";
import {
  INTERVALLE_RELEVE_MIN,
  SEUIL_DEPLACEMENT_METRES,
  INTERVALLE_HEARTBEAT_MIN,
  suiviPositionApplicable,
} from "@/lib/geo-distance";

// GET /api/me — profil de l'utilisateur authentifié.
export async function GET(req: NextRequest) {
  try {
    const { sub } = requireUser(req);
    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user) return fail("Utilisateur introuvable", 404);
    return ok({
      id: user.id,
      email: user.email,
      publicNumber: user.publicNumber,
      pseudo: nomAffichage(user),
      avatarUrl: avatarPublicUrl(user.avatarUrl ?? null),
      statusMsg: user.statusMsg ?? null,
      nom: user.nom ?? null,
      idPays: user.idPays ?? null,
      typeCompte: user.typeCompte,
      isOnline: user.isOnline,
      lastSeen: user.lastSeen ?? null,
      exclus: user.exclus,
      /**
       * Suivi de position : c'est le SERVEUR qui dit si ce compte est concerné,
       * jamais le téléphone. Un particulier reçoit `false` et l'application se
       * comporte alors comme si la fonctionnalité n'existait pas — ni écran de
       * divulgation, ni demande de permission, ni service en arrière-plan.
       *
       * La cadence voyage avec : la changer se fait au serveur, sans avoir à
       * mettre à jour les téléphones déjà déployés.
       */
      suiviPosition: suiviPositionApplicable(user.idCompany),
      suiviPositionIntervalleMin: INTERVALLE_RELEVE_MIN,
      suiviPositionSeuilMetres: SEUIL_DEPLACEMENT_METRES,
      suiviPositionHeartbeatMin: INTERVALLE_HEARTBEAT_MIN,
    });
  } catch (err) {
    if (err instanceof UnauthorizedError) return fail(err.message, 401, "UNAUTHORIZED");
    return handleError(err);
  }
}
