import { NextResponse } from "next/server";
import { ZodError } from "zod";

/**
 * Les réponses de l'API de gestion (`/api/admin/*`).
 *
 * 🔴 PAS LA FORME DU RESTE DU DÉPÔT. Ailleurs, une erreur s'écrit
 * `{ error: { message, code } }` (`src/lib/http.ts`). Ici elle s'écrit
 * `{ error: "message", code: "CODE" }`, celle de la console d'origine
 * (Chris-Manuelpipo/Alanya-admin) : décision du 15/10/2026, pour la rebrancher
 * sans la réécrire. Son client lit `err.response.data.code` AU PREMIER NIVEAU
 * — c'est sur `TOKEN_EXPIRED` qu'il décide de renouveler son jeton. Renvoyer
 * l'autre forme ferait déconnecter l'admin à chaque expiration.
 */

export class ErreurAdmin extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "ErreurAdmin";
    this.status = status;
    this.code = code;
  }
}

export function okAdmin<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function erreurAdmin(status: number, message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status });
}

export function reponseErreurAdmin(err: unknown) {
  if (err instanceof ErreurAdmin) return erreurAdmin(err.status, err.message, err.code);
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "Données invalides", code: "VALIDATION", details: err.flatten() },
      { status: 400 },
    );
  }
  // Une erreur inattendue ne renvoie jamais son message : il peut citer une
  // requête SQL ou un chemin du serveur.
  console.error("[gestion] erreur inattendue :", err);
  return erreurAdmin(500, "Erreur serveur", "INTERNAL");
}
