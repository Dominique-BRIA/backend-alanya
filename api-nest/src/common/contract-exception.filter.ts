import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";
import { ContractException } from "./contract.exception";

/**
 * Traduit TOUTE exception en la forme d'erreur EXACTE du backend Next.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE FILTRE EST OBLIGATOIRE (risque R1 du plan de migration)
 *
 * Laissé à lui-même, Nest répond `{statusCode, message, error}`. Le contrat
 * d'Alanya, lui, est `{error: {message, code}}` — voir `fail()` et
 * `handleError()` dans `src/lib/http.ts`. Sans ce filtre, CHAQUE erreur
 * renvoyée aux clients change de forme, et les applications mobile et web
 * cassent leur affichage des messages d'erreur.
 *
 * Ce filtre reproduit `handleError()` branche par branche, dans le MÊME ORDRE
 * (l'ordre est significatif : un ZodError est aussi une Error).
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ SUBTILITÉ À L'OCTET — la clé `code` absente.
 *
 * Côté Next, `fail(message, status)` construit `{error: {message, code}}` avec
 * `code === undefined`. `JSON.stringify` OMET les propriétés valant `undefined`,
 * si bien que la réponse réelle est `{"error":{"message":"..."}}`, SANS clé
 * `code`. Émettre `"code": null` serait une différence visible pour un client
 * qui teste la présence de la clé. On ne pose donc `code` que s'il existe.
 */
@Catch()
export class ContractExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ContractExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    // 1. Erreur de validation Zod → 422 avec le détail `flatten()`.
    //    Doit passer AVANT le cas générique Error : ZodError en hérite.
    if (exception instanceof ZodError) {
      this.envoyer(res, 422, "Données invalides", "VALIDATION", exception.flatten());
      return;
    }

    // 2. Erreur métier portant son propre code HTTP.
    if (exception instanceof ContractException) {
      this.envoyer(res, exception.status, exception.message, exception.code);
      return;
    }

    // 3. Exception levée par Nest lui-même (404 de routage, corps illisible,
    //    fichier trop volumineux...). Elle porte un statut qu'il faut RESPECTER :
    //    la faire tomber dans le cas générique ci-dessous la transformerait en
    //    400, et un 404 deviendrait un 400.
    if (exception instanceof HttpException) {
      this.envoyer(res, exception.getStatus(), this.messageDe(exception));
      return;
    }

    // 4. Erreur quelconque → 400 avec son message, comme `handleError()`.
    //    Volontairement identique à Next, y compris le fait de renvoyer le
    //    message brut : le corriger ici serait une divergence de contrat.
    if (exception instanceof Error) {
      this.logger.error(`Erreur non typée: ${exception.message}`, exception.stack);
      this.envoyer(res, 400, exception.message);
      return;
    }

    // 5. Rien d'exploitable.
    this.logger.error(`Exception non-Error: ${String(exception)}`);
    this.envoyer(res, 500, "Erreur interne", "INTERNAL");
  }

  /** Extrait le message d'une HttpException, quelle que soit sa forme. */
  private messageDe(exception: HttpException): string {
    const corps = exception.getResponse();
    if (typeof corps === "string") return corps;
    if (corps && typeof corps === "object" && "message" in corps) {
      const message = (corps as { message: unknown }).message;
      if (typeof message === "string") return message;
      // Nest agrège parfois plusieurs messages : on garde le premier, comme
      // le ferait un `Error.message` unique côté Next.
      if (Array.isArray(message) && typeof message[0] === "string") return message[0];
    }
    return exception.message;
  }

  private envoyer(
    res: Response,
    status: number,
    message: string,
    code?: string,
    details?: unknown,
  ): void {
    const erreur: { message: string; code?: string; details?: unknown } = { message };
    // Voir l'avertissement en tête : pas de clé quand la valeur est absente.
    if (code !== undefined) erreur.code = code;
    if (details !== undefined) erreur.details = details;
    res.status(status).json({ error: erreur });
  }
}
