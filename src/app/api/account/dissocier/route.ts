import { type NextRequest } from "next/server";
import { ok, handleError } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { dissocie } from "@/lib/telephone-lie";

/**
 * POST /api/account/dissocier — « Dissocier ce téléphone ».
 *
 * Le compte redevient libre : un autre téléphone pourra s'y connecter. Le
 * téléphone qui était lié perd son accès et ses notifications. Voir
 * `dissocie` pour le détail des effets.
 *
 * Ouverte à toute session du compte, pas seulement au téléphone lié : le web
 * peut dissocier le téléphone (décision du 28/09/2026), et c'est aujourd'hui la
 * seule issue quand le téléphone est perdu ou que l'application a été
 * réinstallée.
 *
 * ⚠️ PAS DE MOT DE PASSE DEMANDÉ, et ce n'est pas un oubli : le geste ne donne
 * aucun accès. Il ferme des sessions et libère une place ; s'en servir sur un
 * autre téléphone exige toujours le mot de passe à la connexion.
 *
 * Réponse : `telephones`, à annoncer au serveur temps réel par le client
 * (`session_revoked`, raison `dissociation`) — l'API ne peut pas joindre
 * `ws-server.mjs` elle-même.
 */
export const POST = withAuth(async (_req: NextRequest, userId: string) => {
  try {
    const { telephones } = await dissocie(userId);
    return ok({ dissocie: true, telephones });
  } catch (err) {
    return handleError(err);
  }
});
