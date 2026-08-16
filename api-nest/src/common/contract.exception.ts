/**
 * Erreur métier portant un code HTTP explicite — équivalent Nest de la classe
 * `HttpError` de `src/lib/http.ts`.
 *
 * ⚠️ On n'utilise PAS `HttpException` de Nest pour le métier : sa sérialisation
 * par défaut produit `{statusCode, message, error}`, alors que le contrat de
 * l'API Alanya est `{error: {message, code}}`. Voir ContractExceptionFilter.
 *
 * `code` reste optionnel, exactement comme `fail(message, status, code?)` :
 * quand il est absent, la clé `code` ne doit PAS apparaître dans le JSON
 * (voir le filtre pour le détail, c'est une subtilité qui se voit à l'octet).
 */
export class ContractException extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ContractException";
    this.status = status;
    this.code = code;
  }
}

/** 401 du contrat — équivalent d'`UnauthorizedError` côté Next. */
export class ContractUnauthorized extends ContractException {
  constructor(message = "Non authentifié") {
    super(401, message, "UNAUTHORIZED");
    this.name = "ContractUnauthorized";
  }
}
