import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

export function fail(message: string, status = 400, code?: string) {
  return NextResponse.json({ error: { message, code } }, { status });
}

// Erreur métier portant un code HTTP explicite.
export class HttpError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/** Une erreur de Prisma : son code a la forme « P2002 ». */
function codePrisma(err: unknown): string | null {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^P\d{4}$/.test(code) ? code : null;
}

/** L'écriture a heurté une contrainte d'unicité (P2002). */
export function estViolationUnicite(err: unknown): boolean {
  return codePrisma(err) === "P2002";
}

// Convertit une erreur quelconque en réponse JSON propre.
export function handleError(err: unknown) {
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: { message: "Données invalides", code: "VALIDATION", details: err.flatten() } },
      { status: 422 },
    );
  }
  if (err instanceof HttpError) {
    return fail(err.message, err.status, err.code);
  }
  /*
   * 🔴 JAMAIS LE MESSAGE D'UNE ERREUR PRISMA À L'UTILISATEUR. Il cite le nom
   * des tables et des colonnes, et ne veut rien dire pour lui (« Invalid
   * `prisma.user.update()` invocation », affiché sur un téléphone le
   * 24/10/2026). Le détail reste dans le journal du serveur.
   */
  const prismaCode = codePrisma(err);
  if (prismaCode) {
    console.error("[prisma]", err);
    if (prismaCode === "P2002") {
      return fail("Cette information est déjà utilisée par un autre compte", 409, "DEJA_UTILISE");
    }
    return fail("Erreur interne", 500, "INTERNAL");
  }
  if (err instanceof Error) {
    return fail(err.message, 400);
  }
  return fail("Erreur interne", 500, "INTERNAL");
}
