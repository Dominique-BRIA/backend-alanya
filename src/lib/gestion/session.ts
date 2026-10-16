import { createHash, createHmac, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import jwt, { TokenExpiredError } from "jsonwebtoken";
import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { ErreurAdmin, reponseErreurAdmin } from "./reponses";
import { PERMISES_EN_LECTURE_SEULE, type Permission } from "./permissions";

/**
 * La session d'administration de la console de gestion.
 *
 * ── QUI SE CONNECTE ─────────────────────────────────────────────────────
 *
 * Le SUPERROOT d'alanyaCenter, à l'identique, sans compte nouveau (décision du
 * 15/10/2026). alanyaCenter en connaît deux sortes, et ce fichier reproduit sa
 * `loginSuperRoot` (`src/controllers/authController.js`) règle pour règle :
 *
 *   1. le COMPTE MAÎTRE, hors base : `SUPER_ROOT_USERNAME` et
 *      `SUPER_ROOT_PASSWORD` dans l'environnement. Mêmes noms de variables que
 *      chez eux, pour qu'on puisse recopier leurs valeurs telles quelles ;
 *   2. toute ligne de la table `Root`, partagée avec eux. Identifiant
 *      insensible à la casse, mot de passe haché par bcrypt OU EN CLAIR (leur
 *      `comparePasswords` accepte les deux), `actif` vérifié APRÈS le mot de
 *      passe, et le type 0 en lecture seule (leur `checkReadOnlyRoot`).
 *
 * ⚠️ UNE DIFFÉRENCE, VOULUE. Sans les deux variables, alanyaCenter retombe sur
 * `superroot` / `superroot`. Ici, sans elles, le compte maître N'EXISTE PAS :
 * un mot de passe connu de tous ne doit jamais naître d'un oubli de
 * configuration. Le jour du déploiement, elles sont posées explicitement.
 *
 * ── LES JETONS ──────────────────────────────────────────────────────────
 *
 * 🔴 ILS NE SONT PAS SIGNÉS AVEC LES CLÉS DE L'APPLICATION. Les clés sont
 * DÉRIVÉES de `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` par HMAC : un jeton
 * de gestion ne passe donc aucune vérification de l'application mobile, et un
 * jeton mobile n'ouvre aucune route de gestion — même si les deux portaient le
 * même `scope` par erreur. Dériver plutôt qu'ajouter deux secrets au `.env` :
 * rien à configurer, et rien à oublier.
 *
 * 🔴 CHAQUE JETON PORTE UNE EMPREINTE DU MOT DE PASSE (`v`). Elle est
 * recalculée à chaque requête : changer le mot de passe — dans l'environnement
 * pour le maître, en base pour un `Root` — fait tomber toutes les sessions
 * ouvertes, sans liste de révocation. Désactiver un `Root` (`actif = 0`) aussi,
 * puisque la ligne est relue à chaque fois.
 */

const AUDIENCE = "alanya-gestion";
const DUREE_ACCES = "30m";
const DUREE_RENOUVELLEMENT = "7d";

type Portee = "gestion" | "gestion-refresh";

interface ChargeJeton {
  sub: string; // "master" ou l'idRoot
  scope: Portee;
  v: string;
}

export interface SessionAdmin {
  idRoot: number | "master";
  username: string;
  /** Le type de la ligne `Root` ; 1 pour le maître, comme chez alanyaCenter. */
  type: number;
  isMaster: boolean;
  lectureSeule: boolean;
}

function cle(base: string): string {
  return createHmac("sha256", base).update(AUDIENCE).digest("hex");
}

const cleAcces = () => cle(env.jwt.accessSecret());
const cleRenouvellement = () => cle(env.jwt.refreshSecret());

function empreinte(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

function egalConstant(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function compteMaitre(): { username: string; password: string } | null {
  const username = process.env.SUPER_ROOT_USERNAME?.trim();
  const password = process.env.SUPER_ROOT_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

/** bcrypt, ou le texte en clair : ce qu'accepte alanyaCenter. */
async function motDePasseValide(saisi: string, enBase: string | null): Promise<boolean> {
  if (!enBase) return false;
  if (/^\$2[aby]\$/.test(enBase)) return bcrypt.compare(saisi, enBase);
  return egalConstant(saisi, enBase);
}

function sessionMaitre(m: { username: string }): SessionAdmin {
  return { idRoot: "master", username: m.username, type: 1, isMaster: true, lectureSeule: false };
}

function sessionRoot(r: { idRoot: number; username: string; type: number }): SessionAdmin {
  return {
    idRoot: r.idRoot,
    username: r.username,
    type: r.type,
    isMaster: false,
    lectureSeule: r.type === 0,
  };
}

/** Vérifie les identifiants. Lève une `ErreurAdmin` si l'accès est refusé. */
export async function connecter(identifiant: string, motDePasse: string): Promise<SessionAdmin> {
  const saisie = identifiant.trim().toLowerCase();

  const maitre = compteMaitre();
  if (maitre && saisie === maitre.username.toLowerCase() && egalConstant(motDePasse, maitre.password)) {
    return sessionMaitre(maitre);
  }

  const root = await prisma.root.findFirst({
    where: { username: { equals: saisie, mode: "insensitive" } },
  });
  // Même message pour un identifiant inconnu et un mot de passe faux : la
  // réponse ne doit pas dire quels identifiants existent.
  if (!root || !(await motDePasseValide(motDePasse, root.password))) {
    throw new ErreurAdmin(401, "Identifiants invalides", "INVALID_CREDENTIALS");
  }
  if (root.actif === 0) {
    throw new ErreurAdmin(403, "Ce compte a été désactivé", "ACCOUNT_INACTIVE");
  }
  return sessionRoot(root);
}

async function versionDe(session: SessionAdmin): Promise<string | null> {
  if (session.isMaster) {
    const m = compteMaitre();
    return m ? empreinte("master", m.username.toLowerCase(), m.password) : null;
  }
  const root = await prisma.root.findUnique({ where: { idRoot: session.idRoot as number } });
  return root ? empreinte("root", String(root.idRoot), root.password) : null;
}

export async function emettreJetons(session: SessionAdmin) {
  const v = await versionDe(session);
  if (!v) throw new ErreurAdmin(401, "Session refusée", "SESSION_REJECTED");
  const sub = String(session.idRoot);
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
  let session: SessionAdmin;
  if (charge.sub === "master") {
    const m = compteMaitre();
    if (!m) throw rejet;
    session = sessionMaitre(m);
  } else {
    const idRoot = Number(charge.sub);
    if (!Number.isInteger(idRoot)) throw rejet;
    const root = await prisma.root.findUnique({ where: { idRoot } });
    if (!root || root.actif === 0) throw rejet;
    session = sessionRoot(root);
  }
  if ((await versionDe(session)) !== charge.v) throw rejet;
  return session;
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

export { motDePasseValide };

const ECRITURES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * L'enveloppe de toute route de gestion : identifie, applique la lecture
 * seule, convertit les erreurs au format de la console.
 *
 * ⚠️ LA PERMISSION EST OBLIGATOIRE MÊME SI TOUT LE MONDE LES A TOUTES : c'est
 * elle qui dit si une écriture reste permise en lecture seule, et c'est le
 * point unique à modifier le jour où un rôle limité arrivera.
 */
export function routeAdmin<C>(
  permission: Permission,
  gestionnaire: (req: NextRequest, session: SessionAdmin, ctx: C) => Promise<Response>,
  /// `lecture: true` : un POST qui n'écrit rien (une estimation, un calcul).
  /// Il reste alors permis à un compte en lecture seule.
  options: { lecture?: boolean } = {},
) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      const session = await identifier(req);
      if (
        session.lectureSeule &&
        !options.lecture &&
        ECRITURES.has(req.method) &&
        !PERMISES_EN_LECTURE_SEULE.has(permission)
      ) {
        throw new ErreurAdmin(403, "Accès refusé : vous ne disposez que des droits de lecture", "READ_ONLY");
      }
      return await gestionnaire(req, session, ctx);
    } catch (err) {
      return reponseErreurAdmin(err);
    }
  };
}
