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
      /**
       * Le compte porte-t-il un identifiant de récupération ?
       *
       * 🔴 UN BOOLÉEN, JAMAIS L'IDENTIFIANT LUI-MÊME. Ce profil est chargé à
       * chaque ouverture de l'application, journalisé par les proxys et gardé
       * en cache par les clients : y mettre le secret le sèmerait dans dix
       * endroits qui n'ont aucune raison de le connaître. Il ne se demande
       * qu'explicitement, à `GET /api/account/recovery-id`.
       *
       * Savoir qu'il EXISTE suffit à l'écran des réglages pour décider
       * d'afficher l'entrée « Voir mon identifiant » ou, à l'inverse,
       * « Ajouter une adresse ».
       */
      aIdRecuperation: user.idRecuperation !== null,
      publicNumber: user.publicNumber,
      pseudo: nomAffichage(user),
      avatarUrl: avatarPublicUrl(user.avatarUrl ?? null),
      statusMsg: user.statusMsg ?? null,
      nom: user.nom ?? null,
      /**
       * Le numéro de LIGNE déclaré par l'utilisateur, en forme canonique.
       *
       * ⚠️ À NE PAS CONFONDRE AVEC `publicNumber`, l'Alanya ID : celui-là est
       * l'identité du compte — ce que les contacts ont enregistré et ce qu'on
       * compose — et il ne change jamais. `mobile` n'est qu'une information de
       * contact, modifiable sous mot de passe
       * (`POST /api/account/mobile`).
       *
       * Ajouté le 26/08/2026 pour que l'écran « Pays et téléphone » puisse
       * afficher le numéro EN COURS plutôt que la dernière saisie.
       */
      mobile: user.mobile ?? null,
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
