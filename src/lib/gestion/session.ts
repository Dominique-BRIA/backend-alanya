import { createHash, createHmac } from "crypto";
import jwt, { TokenExpiredError } from "jsonwebtoken";
import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { verifyPassword } from "@/lib/password";
import { nomAffichage } from "@/lib/display-name.mjs";
import { ErreurAdmin, reponseErreurAdmin } from "./reponses";
import { peut, ROLE_UTILISATEUR, type Permission } from "./permissions";

/**
 * La session d'administration de la console de gestion.
 *
 * ── QUI SE CONNECTE (depuis le 24/10/2026) ──────────────────────────────
 *
 * Comme chez Alanya2026 (`src/controllers/admin/auth.js`) : un COMPTE ALANYA
 * promu Admin ou Super Admin (`users.role_admin` > 0), avec le mot de passe de
 * ce compte — le même que dans l'application. Le user a ajouté une chose :
 * l'identifiant peut être l'adresse e-mail OU le numéro Alanya, puisque nos
 * comptes n'ont pas tous une adresse.
 *
 * Le superroot d'alanyaCenter, qui se connectait jusque-là, n'entre plus
 * (décision du 24/10/2026).
 *
 * ── LES JETONS ──────────────────────────────────────────────────────────
 *
 * 🔴 ILS NE SONT PAS SIGNÉS AVEC LES CLÉS DE L'APPLICATION. Les clés sont
 * DÉRIVÉES de `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` par HMAC : un jeton
 * de gestion ne passe aucune vérification de l'application mobile, et un
 * jeton mobile n'ouvre aucune route de gestion.
 *
 * 🔴 CHAQUE JETON PORTE UNE EMPREINTE (`v`) du mot de passe ET du rôle,
 * recalculée à chaque requête : changer le mot de passe, retirer le rôle ou
 * bannir le compte fait tomber toutes ses sessions, sans liste de révocation.
 */

const AUDIENCE = "alanya-gestion";
const DUREE_ACCES = "30m";
const DUREE_RENOUVELLEMENT = "7d";

type Portee = "gestion" | "gestion-refresh";

interface ChargeJeton {
  sub: string; // l'identifiant du compte
  scope: Portee;
  v: string;
}

export interface SessionAdmin {
  userId: string;
  /** Le nom affiché, pour le journal d'audit et les auteurs. */
  nom: string;
  role: number;
  /// Ce que la route veut voir au journal d'audit, en plus de ce que
  /// `routeAdmin` déduit seul (cible du chemin) : un motif, une cible précise.
  audit?: { cibleType?: string; cibleId?: string; motif?: string | null };
}

function cle(base: string): string {
  return createHmac("sha256", base).update(AUDIENCE).digest("hex");
}

const cleAcces = () => cle(env.jwt.accessSecret());
const cleRenouvellement = () => cle(env.jwt.refreshSecret());

function empreinte(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

const CHAMPS_COMPTE = {
  id: true,
  nom: true,
  pseudo: true,
  publicNumber: true,
  passwordHash: true,
  roleAdmin: true,
  exclus: true,
  actif: true,
  isDelete: true,
} as const;

type CompteAdmin = {
  id: string;
  nom: string | null;
  pseudo: string | null;
  publicNumber: string;
  passwordHash: string | null;
  roleAdmin: number;
  exclus: number;
  actif: number;
  isDelete: boolean;
};

function sessionDe(c: CompteAdmin): SessionAdmin {
  return { userId: c.id, nom: nomAffichage(c), role: c.roleAdmin };
}

const versionDe = (c: CompteAdmin) => empreinte("user", c.id, c.passwordHash ?? "", String(c.roleAdmin));

/**
 * Le compte désigné par l'identifiant saisi : une adresse e-mail (insensible à
 * la casse) ou un numéro Alanya (espaces, tirets et points ignorés).
 */
async function compteDe(identifiant: string): Promise<CompteAdmin | null> {
  const saisie = identifiant.trim();
  if (saisie.includes("@")) {
    return prisma.user.findFirst({
      where: { email: { equals: saisie.toLowerCase(), mode: "insensitive" } },
      select: CHAMPS_COMPTE,
    });
  }
  const numero = saisie.replace(/[\s.\-]/g, "");
  if (!/^\d{6,20}$/.test(numero)) return null;
  return prisma.user.findUnique({ where: { publicNumber: numero }, select: CHAMPS_COMPTE });
}

/** Vérifie les identifiants. Lève une `ErreurAdmin` si l'accès est refusé. */
export async function connecter(identifiant: string, motDePasse: string): Promise<SessionAdmin> {
  const compte = await compteDe(identifiant);
  // Le mot de passe est vérifié AVANT de dire quoi que ce soit du compte : un
  // inconnu ne doit apprendre ni qu'il existe, ni qu'il est banni, ni son rôle.
  if (
    !compte ||
    compte.isDelete ||
    !compte.passwordHash ||
    !(await verifyPassword(motDePasse, compte.passwordHash))
  ) {
    throw new ErreurAdmin(401, "Identifiants invalides", "INVALID_CREDENTIALS");
  }
  if (compte.exclus === 1 || compte.actif === 0) {
    throw new ErreurAdmin(403, "Compte banni", "ACCOUNT_BANNED");
  }
  if (compte.roleAdmin <= ROLE_UTILISATEUR) {
    throw new ErreurAdmin(403, "Accès admin requis", "INSUFFICIENT_ROLE");
  }
  return sessionDe(compte);
}

export async function emettreJetons(session: SessionAdmin) {
  const compte = await prisma.user.findUnique({ where: { id: session.userId }, select: CHAMPS_COMPTE });
  if (!compte) throw new ErreurAdmin(401, "Session refusée", "SESSION_REJECTED");
  const v = versionDe(compte);
  const sub = compte.id;
  const options = { audience: AUDIENCE } as const;
  return {
    accessToken: jwt.sign({ sub, scope: "gestion", v } satisfies ChargeJeton, cleAcces(), {
      ...options,
      expiresIn: DUREE_ACCES,
    }),
    refreshToken: jwt.sign({ sub, scope: "gestion-refresh", v } satisfies ChargeJeton, cleRenouvellement(), {
      ...options,
      expiresIn: DUREE_RENOUVELLEMENT,
    }),
  };
}

/** Relit le compte désigné par un jeton, et vérifie qu'il vaut toujours. */
async function rechargerSession(charge: ChargeJeton): Promise<SessionAdmin> {
  const rejet = new ErreurAdmin(401, "Session refusée", "SESSION_REJECTED");
  if (!/^[0-9a-f-]{36}$/i.test(charge.sub)) throw rejet;
  const compte = await prisma.user.findUnique({ where: { id: charge.sub }, select: CHAMPS_COMPTE });
  if (!compte || compte.isDelete || compte.exclus === 1 || compte.actif === 0) throw rejet;
  if (compte.roleAdmin <= ROLE_UTILISATEUR) throw rejet;
  if (versionDe(compte) !== charge.v) throw rejet;
  return sessionDe(compte);
}

function verifier(jeton: string, cleSignature: string, portee: Portee): ChargeJeton {
  let charge: ChargeJeton;
  try {
    charge = jwt.verify(jeton, cleSignature, { audience: AUDIENCE }) as ChargeJeton;
  } catch (e) {
    if (e instanceof TokenExpiredError) throw new ErreurAdmin(401, "Token expiré", "TOKEN_EXPIRED");
    throw new ErreurAdmin(401, "Token invalide", "TOKEN_INVALID");
  }
  if (charge.scope !== portee) throw new ErreurAdmin(401, "Type de token invalide", "TOKEN_TYPE_INVALID");
  return charge;
}

export async function identifier(req: NextRequest): Promise<SessionAdmin> {
  const entete = req.headers.get("authorization");
  if (!entete?.startsWith("Bearer ")) throw new ErreurAdmin(401, "Pas de token fourni", "TOKEN_REQUIRED");
  return rechargerSession(verifier(entete.slice(7).trim(), cleAcces(), "gestion"));
}

export async function renouveler(jetonRenouvellement: string) {
  const session = await rechargerSession(verifier(jetonRenouvellement, cleRenouvellement(), "gestion-refresh"));
  return { session, ...(await emettreJetons(session)) };
}

const ECRITURES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * L'enveloppe de toute route de gestion : identifie, vérifie la permission du
 * rôle, convertit les erreurs au format de la console.
 *
 * Le refus de permission a la forme de leur `requirePermission` :
 * 403 `{ error: "Permission requise", permission, code: "INSUFFICIENT_ROLE" }`.
 */
export function routeAdmin<C>(
  permission: Permission,
  gestionnaire: (req: NextRequest, session: SessionAdmin, ctx: C) => Promise<Response>,
  /// `lecture: true` : un POST qui n'écrit rien (une estimation, un calcul).
  /// Il ne va pas au journal d'audit.
  options: { lecture?: boolean } = {},
) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    let session: SessionAdmin | null = null;
    let reponse: Response;
    try {
      session = await identifier(req);
      if (!peut(session.role, permission)) {
        reponse = Response.json(
          { error: "Permission requise", permission, code: "INSUFFICIENT_ROLE" },
          { status: 403 },
        );
      } else {
        reponse = await gestionnaire(req, session, ctx);
      }
    } catch (err) {
      reponse = reponseErreurAdmin(err);
    }
    // Toute ÉCRITURE d'une session identifiée va au journal, refus compris :
    // une tentative refusée en dit autant qu'une action réussie.
    if (session && ECRITURES.has(req.method) && !options.lecture) {
      await journaliser(req, session, permission, reponse.status);
    }
    return reponse;
  };
}

/** L'auteur d'une action, tel que l'écrivent le journal et les tables de gestion. */
export const auteurId = (session: SessionAdmin) => `user:${session.userId}`;

/**
 * Inscrit une écriture au journal d'audit (`gestion_audit`).
 *
 * La cible est déduite du chemin — `/api/admin/users/<id>/ban` → `users`,
 * `<id>` — sauf si la route l'a précisée dans `session.audit`.
 *
 * ⚠️ UN ÉCHEC D'ÉCRITURE DU JOURNAL N'ANNULE PAS L'ACTION : elle a déjà eu
 * lieu. On le dit dans les journaux du serveur, sans le cacher.
 */
async function journaliser(req: NextRequest, session: SessionAdmin, action: string, statut: number) {
  const morceaux = req.nextUrl.pathname.replace(/^\/api\/admin\/?/, "").split("/").filter(Boolean);
  try {
    await prisma.gestionAudit.create({
      data: {
        admin: auteurId(session),
        adminNom: session.nom.slice(0, 100),
        action,
        route: `${req.method} ${req.nextUrl.pathname}`.slice(0, 200),
        cibleType: (session.audit?.cibleType ?? morceaux[0] ?? null)?.slice(0, 40) ?? null,
        cibleId: (session.audit?.cibleId ?? morceaux[1] ?? null)?.slice(0, 80) ?? null,
        motif: session.audit?.motif?.slice(0, 500) ?? null,
        ip: (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip"))?.slice(0, 64) ?? null,
        statutHttp: statut,
      },
    });
  } catch (e) {
    console.error("[gestion] journal d'audit :", e);
  }
}
