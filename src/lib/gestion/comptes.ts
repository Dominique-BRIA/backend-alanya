import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { generateUniquePublicNumber } from "@/lib/publicNumber";
import { genererIdRecuperationUnique } from "@/lib/id-recuperation";
import { ALANYA_ID_REGEX } from "@/lib/validation";
import { invaliderProfil } from "@/lib/cache-redis.mjs";
import { RAISON_REVOCATION } from "@/lib/sessions";
import { TYPE_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";
import { ErreurAdmin } from "./reponses";
import { auteur, type pagination } from "./outils";
import { type SessionAdmin } from "./session";

/**
 * LES COMPTES vus de la console de gestion (16/10/2026).
 *
 * La forme rendue est celle de la console d'origine (`User` d'Alanya-admin),
 * avec NOS valeurs : `alanyaID` est l'UUID du compte, `typeCompte` notre type
 * (0 personne, 2 agent, 3 centre d'appels, 4 centre vocal, 5 officiel,
 * 9 modérateur). `accountType` n'existe pas chez nous : 0, sauf l'officiel (2,
 * la valeur qui allume le badge « officiel » de la console).
 *
 * ⚠️ CE QUE LA CONSOLE NE FAIT PAS ICI, PAR CONSTRUCTION : rattacher un agent
 * à une entreprise ou créer un centre d'appels. C'est le métier d'alanyaCenter,
 * qui partage cette base ; le refaire ici créerait deux portes pour la même
 * règle. La création se limite donc aux comptes ordinaires et aux modérateurs.
 */

const AVEC_PAYS = { pays: { select: { libelle: true, prefix: true } } } as const;
type CompteAvecPays = Prisma.UserGetPayload<{ include: typeof AVEC_PAYS }>;

export function presenterCompte(u: CompteAvecPays) {
  return {
    alanyaID: u.id,
    nom: u.nom ?? "",
    pseudo: u.pseudo ?? "",
    alanyaPhone: u.publicNumber,
    email: u.email ?? "",
    idPays: u.idPays,
    avatarUrl: u.avatarUrl ?? "",
    typeCompte: u.typeCompte,
    accountType: u.typeCompte === TYPE_COMPTE_OFFICIEL ? 2 : 0,
    verificationStatus: u.verificationStatut,
    verifiedUntil: u.verifieJusqua,
    isOnline: u.isOnline === 1,
    lastSeen: u.lastSeen,
    exclus: u.exclus === 1,
    excludeAt: u.excludeAt,
    excludeReason: u.excludeReason,
    createdAt: u.createdAt,
    paysLibelle: u.pays?.libelle ?? null,
    actif: u.actif === 1,
  };
}

export function presenterCompteDetail(u: CompteAvecPays) {
  return {
    ...presenterCompte(u),
    fcmToken: u.fcmToken ? "•••" : "",
    deviceID: u.deviceId ?? "",
    paysPrefix: u.pays?.prefix ?? "",
    mobile: u.mobile,
    appareilTotal: u.appareilTotal,
    idCompany: u.idCompany,
  };
}

const TRIS: Record<string, Prisma.UserOrderByWithRelationInput> = {
  created_at: { createdAt: "desc" },
  nom: { nom: "desc" },
  last_seen: { lastSeen: "desc" },
};

/** Le filtre de la liste — partagé avec l'export, qui doit rendre la même chose. */
export function filtreComptes(p: URLSearchParams): Prisma.UserWhereInput {
  const et: Prisma.UserWhereInput[] = [{ isDelete: false }];
  const q = p.get("search")?.trim();
  if (q) {
    et.push({
      OR: [
        { nom: { contains: q, mode: "insensitive" } },
        { pseudo: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { publicNumber: { startsWith: q.replace(/\D/g, "") || q } },
        { mobile: { contains: q.replace(/\D/g, "") || q } },
      ],
    });
  }
  const statut = p.get("status");
  if (statut === "online") et.push({ isOnline: 1 });
  else if (statut === "banned") et.push({ exclus: 1 });
  else if (statut === "admin") et.push({ typeCompte: 9 });
  const idPays = Number(p.get("idPays"));
  if (Number.isInteger(idPays) && idPays > 0) et.push({ idPays });
  const type = p.get("type_compte");
  if (type !== null && type !== "" && Number.isInteger(Number(type))) et.push({ typeCompte: Number(type) });
  const from = p.get("from");
  const to = p.get("to");
  if (from || to) {
    et.push({
      createdAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to) } : {}),
      },
    });
  }
  return { AND: et };
}

export async function listerComptes(p: URLSearchParams, pg: ReturnType<typeof pagination>) {
  const where = filtreComptes(p);
  const base = TRIS[p.get("sort") ?? "created_at"] ?? TRIS.created_at;
  const sens = p.get("order") === "asc" ? "asc" : "desc";
  const orderBy = Object.fromEntries(Object.keys(base).map((k) => [k, sens])) as Prisma.UserOrderByWithRelationInput;
  const [lignes, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: [orderBy, { id: "asc" }], skip: pg.skip, take: pg.limit, include: AVEC_PAYS }),
    prisma.user.count({ where }),
  ]);
  return { items: lignes.map(presenterCompte), total, page: pg.page, limit: pg.limit };
}

export async function compteRequis(id: string) {
  const u = await prisma.user.findUnique({ where: { id }, include: AVEC_PAYS });
  if (!u || u.isDelete) throw new ErreurAdmin(404, "Compte introuvable", "USER_NOT_FOUND");
  return u;
}

export async function activiteCompte(id: string) {
  const [messagesSent, conversations, callsMade, callsReceived, statusesPublished] = await Promise.all([
    prisma.message.count({ where: { senderId: id } }),
    prisma.participant.count({ where: { userId: id, estMembre: true } }),
    prisma.call.count({ where: { initiatorId: id } }),
    prisma.callParticipant.count({ where: { userId: id, call: { initiatorId: { not: id } } } }),
    prisma.status.count({ where: { userId: id } }),
  ]);
  return { messagesSent, conversations, callsMade, callsReceived, statusesPublished };
}

export async function connexionsCompte(id: string) {
  const lignes = await prisma.userAccess.findMany({ where: { alanyaId: id }, orderBy: { dateLogin: "desc" }, take: 100 });
  return lignes.map((l) => ({
    idLogin: Number(l.idLogin),
    dateLogin: l.dateLogin,
    os_system: l.osSystem,
    device: l.device,
    ipAdress: l.ipAdress,
  }));
}

/** Coupe toutes les sessions d'un compte : ses jetons de renouvellement sont révoqués. */
async function couperSessions(id: string) {
  await prisma.refreshToken.updateMany({
    where: { userId: id, revoked: false },
    data: { revoked: true, revokedReason: RAISON_REVOCATION },
  });
}

function compteModifiable(u: { typeCompte: number }) {
  if (u.typeCompte === TYPE_COMPTE_OFFICIEL) {
    throw new ErreurAdmin(400, "Le compte officiel se gère depuis son propre écran", "OFFICIAL_ACCOUNT");
  }
}

export async function bannir(id: string, motif: string | null) {
  const u = await compteRequis(id);
  compteModifiable(u);
  await prisma.user.update({
    where: { id },
    data: { exclus: 1, excludeAt: new Date(), excludeReason: motif?.slice(0, 255) ?? null },
  });
  // La connexion refuse déjà un compte exclu ; couper ses jetons le déconnecte
  // au plus tard à l'expiration de son jeton d'accès (15 min).
  await couperSessions(id);
  await invaliderProfil(id);
}

export async function rehabiliter(id: string) {
  await compteRequis(id);
  await prisma.user.update({ where: { id }, data: { exclus: 0, excludeAt: null, excludeReason: null } });
  await invaliderProfil(id);
}

/**
 * Supprime un compte : effacement LOGIQUE (`isDelete`), sessions coupées,
 * connexion refusée. Rien n'est détruit — les conversations des autres
 * gardent leurs messages, alanyaCenter garde ses références.
 */
export async function supprimer(id: string) {
  const u = await compteRequis(id);
  compteModifiable(u);
  await prisma.user.update({ where: { id }, data: { isDelete: true, exclus: 1, excludeAt: new Date() } });
  await couperSessions(id);
  await invaliderProfil(id);
}

/* ══════════════ Numéros Alanya ══════════════ */

export function numeroCanonique(brut: string) {
  return String(brut ?? "").replace(/\D/g, "");
}

/** Le diagnostic que l'écran affiche avant d'attribuer un numéro. */
export async function verifierNumero(brut: string, pourCompte?: string) {
  const numero = numeroCanonique(brut);
  const formatValide = ALANYA_ID_REGEX.test(numero);
  const [reserve, porteur] = await Promise.all([
    prisma.reservedAlanyaPhone.findUnique({ where: { phoneCanonical: numero } }).catch(() => null),
    formatValide ? prisma.user.findUnique({ where: { publicNumber: numero }, select: { id: true } }) : null,
  ]);
  const pris = !!porteur && porteur.id !== pourCompte;
  const raison = !formatValide
    ? "Format invalide : 6 à 8 chiffres"
    : pris
      ? "Ce numéro est déjà attribué"
      : null;
  return {
    phone_canonical: numero,
    tier: numero.length,
    is_pattern_reserved: false,
    in_reserved_table: !!reserve,
    is_taken: pris,
    assignable: formatValide && !pris,
    reason: raison,
    source: reserve ? "table" : "standard",
    hint: reserve ? `Numéro réservé (« ${reserve.label} ») : seule la console peut l'attribuer` : null,
  };
}

export async function changerNumero(id: string, brut: string, session: SessionAdmin) {
  const u = await compteRequis(id);
  compteModifiable(u);
  const verdict = await verifierNumero(brut, id);
  if (!verdict.assignable) throw new ErreurAdmin(409, verdict.reason ?? "Numéro refusé", "PHONE_NOT_ASSIGNABLE");
  if (verdict.phone_canonical === u.publicNumber) return;
  try {
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { publicNumber: verdict.phone_canonical } }),
      prisma.gestionNumeroHistorique.create({
        data: { userId: id, ancien: u.publicNumber, nouveau: verdict.phone_canonical, changePar: auteur(session) },
      }),
    ]);
  } catch (e) {
    // Course perdue contre une autre attribution : l'unicité de la base tranche.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ErreurAdmin(409, "Ce numéro vient d'être attribué", "PHONE_NOT_ASSIGNABLE");
    }
    throw e;
  }
  await invaliderProfil(id);
}

export async function historiqueNumero(id: string) {
  const lignes = await prisma.gestionNumeroHistorique.findMany({ where: { userId: id }, orderBy: { changeLe: "desc" } });
  return {
    quarantineDays: 0,
    pendingCredit: null,
    history: lignes.map((l) => ({
      id: Number(l.id),
      oldPhone: l.ancien,
      newPhone: l.nouveau,
      source: "admin",
      changedAt: l.changeLe,
      changedByName: l.changePar === "master" ? "Master Super Root" : l.changePar,
      amount: null,
      currency: null,
    })),
  };
}

/* ══════════════ Création ══════════════ */

/// Types qu'on peut créer d'ici : un compte ordinaire, un modérateur. Les
/// agents et les centres naissent dans alanyaCenter, rattachés à une entreprise.
const TYPES_CREABLES = [0, 9];

const creationSchema = z.object({
  nom: z.string().trim().min(1).max(100),
  pseudo: z.string().trim().min(1).max(50),
  password: z.string().min(8).max(200),
  email: z.string().trim().toLowerCase().email().max(100).optional().or(z.literal("").transform(() => undefined)),
  alanyaPhone: z.string().optional(),
  generateLength: z.coerce.number().optional(),
  idPays: z.coerce.number().int().positive().optional(),
  type_compte: z.coerce.number().int().optional(),
});

export async function creerCompte(brut: unknown) {
  const r = creationSchema.safeParse(brut);
  if (!r.success) throw new ErreurAdmin(400, "Nom, pseudo et mot de passe (8 caractères au moins) requis", "VALIDATION");
  const c = r.data;
  const type = c.type_compte ?? 0;
  if (!TYPES_CREABLES.includes(type)) {
    throw new ErreurAdmin(400, "Les agents et les centres se créent dans alanyaCenter", "TYPE_NOT_ALLOWED");
  }
  if (c.generateLength && c.generateLength !== 8 && !c.alanyaPhone) {
    throw new ErreurAdmin(400, "Les numéros générés font 8 chiffres", "INVALID_LENGTH");
  }
  if (c.idPays && !(await prisma.pays.findUnique({ where: { idPays: c.idPays } }))) {
    throw new ErreurAdmin(404, "Pays introuvable", "PAYS_NOT_FOUND");
  }
  let numero: string;
  if (c.alanyaPhone?.trim()) {
    const verdict = await verifierNumero(c.alanyaPhone);
    if (!verdict.assignable) throw new ErreurAdmin(409, verdict.reason ?? "Numéro refusé", "PHONE_NOT_ASSIGNABLE");
    numero = verdict.phone_canonical;
  } else {
    numero = await generateUniquePublicNumber();
  }
  try {
    const u = await prisma.user.create({
      data: {
        nom: c.nom,
        pseudo: c.pseudo,
        email: c.email ?? null,
        // Créé par l'administration : l'adresse est réputée sûre.
        emailVerified: !!c.email,
        passwordHash: await hashPassword(c.password),
        publicNumber: numero,
        idRecuperation: c.email ? null : await genererIdRecuperationUnique(),
        idPays: c.idPays ?? null,
        typeCompte: type,
      },
      include: AVEC_PAYS,
    });
    return u;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ErreurAdmin(409, "Adresse e-mail ou numéro déjà utilisé", "ALREADY_EXISTS");
    }
    throw e;
  }
}
