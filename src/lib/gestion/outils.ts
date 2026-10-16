import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { type SessionAdmin } from "./session";
import { ErreurAdmin } from "./reponses";

/** Les petits outils partagés par les routes de la console de gestion. */

/** `?page&limit`, bornés. */
export function pagination(p: URLSearchParams, defaut = 20, max = 100) {
  const page = Math.max(1, Number(p.get("page")) || 1);
  const limit = Math.min(max, Math.max(1, Number(p.get("limit")) || defaut));
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * `?from&to` (dates ISO ou AAAA-MM-JJ) → la période, et la précédente de même
 * durée — pour les comparaisons des tableaux de bord. 30 derniers jours par défaut.
 */
export function periode(p: URLSearchParams) {
  const lire = (v: string | null, fin: boolean) => {
    if (!v) return null;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${fin ? "23:59:59.999" : "00:00:00"}Z`) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const to = lire(p.get("to"), true) ?? new Date();
  const from = lire(p.get("from"), false) ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from > to) throw new ErreurAdmin(400, "Période invalide", "INVALID_PERIOD");
  const duree = to.getTime() - from.getTime();
  return {
    from,
    to,
    prevFrom: new Date(from.getTime() - duree),
    prevTo: from,
  };
}

/** Identifiant de l'auteur dans les tables de la console : `master` ou `root:<id>`. */
export function auteur(session: SessionAdmin): string {
  return session.isMaster ? "master" : `root:${session.idRoot}`;
}
export function nomAuteur(session: SessionAdmin): string {
  return session.isMaster ? "Master Super Root" : session.username;
}

/** Lit un réglage de la console, complété par ses valeurs par défaut. */
export async function lireReglage<T extends object>(cle: string, defaut: T) {
  const r = await prisma.gestionReglage.findUnique({ where: { cle } });
  return {
    valeur: { ...defaut, ...((r?.valeur as object | null) ?? {}) } as T,
    modifieLe: r?.modifieLe ?? null,
    modifiePar: r?.modifiePar ?? null,
  };
}

export async function ecrireReglage(cle: string, valeur: object, session: SessionAdmin) {
  const v = valeur as Prisma.InputJsonValue;
  return prisma.gestionReglage.upsert({
    where: { cle },
    create: { cle, valeur: v, modifiePar: auteur(session) },
    update: { valeur: v, modifiePar: auteur(session), modifieLe: new Date() },
  });
}

/** Un identifiant numérique de la console (`/:id`), ou 404. */
export function idNumerique(brut: string, code = "NOT_FOUND"): bigint {
  if (!/^\d{1,18}$/.test(brut)) throw new ErreurAdmin(404, "Introuvable", code);
  return BigInt(brut);
}

/** Un identifiant de compte, de message ou de fil (UUID), ou 404. */
export function idUuid(brut: string, code = "NOT_FOUND"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(brut)) {
    throw new ErreurAdmin(404, "Introuvable", code);
  }
  return brut.toLowerCase();
}

/** Un CSV (séparateur `;`, BOM pour Excel), prêt à télécharger. */
export function reponseCsv(nom: string, entetes: string[], lignes: unknown[][]) {
  const cellule = (v: unknown) => {
    const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const corps = [entetes, ...lignes].map((l) => l.map(cellule).join(";")).join("\r\n");
  return new Response(`﻿${corps}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nom}"`,
    },
  });
}

/** Série quotidienne complète (jours sans valeur à 0), du plus ancien au plus récent. */
export function serieJours(from: Date, to: Date, valeurs: Map<string, number>) {
  const serie: { date: string; count: number }[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  while (d <= to && serie.length < 400) {
    const cle = d.toISOString().slice(0, 10);
    serie.push({ date: cle, count: valeurs.get(cle) ?? 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return serie;
}
