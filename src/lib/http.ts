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
  if (err instanceof Error) {
    return fail(err.message, 400);
  }
  return fail("Erreur interne", 500, "INTERNAL");
}
