import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { generateUniquePublicNumber } from "@/lib/publicNumber";
import { NOM_COMPTE_OFFICIEL, TYPE_COMPTE_OFFICIEL } from "@/lib/compte-officiel.mjs";
import { ErreurAdmin } from "./reponses";

/**
 * Le compte officiel côté console : le trouver, le créer, le présenter.
 * La règle « personne ne lui répond » vit dans `src/lib/compte-officiel.mjs`.
 */

const CHAMPS = {
  id: true,
  nom: true,
  pseudo: true,
  publicNumber: true,
  avatarUrl: true,
  typeCompte: true,
  createdAt: true,
  idPays: true,
} as const;

/** Le compte officiel, ou `null` s'il n'a pas encore été créé. Le plus ancien s'il y en avait deux. */
export function trouverCompteOfficiel() {
  return prisma.user.findFirst({
    where: { typeCompte: TYPE_COMPTE_OFFICIEL, isDelete: false },
    orderBy: { createdAt: "asc" },
    select: CHAMPS,
  });
}

/** L'identifiant du compte officiel ; lève 409 s'il n'existe pas. */
export async function idCompteOfficielRequis(): Promise<string> {
  const compte = await trouverCompteOfficiel();
  if (!compte) {
    throw new ErreurAdmin(409, "Aucun compte officiel : créez-le avant de diffuser", "OFFICIAL_ACCOUNT_MISSING");
  }
  return compte.id;
}

type Compte = NonNullable<Awaited<ReturnType<typeof trouverCompteOfficiel>>>;

/**
 * La forme qu'attend la console (`OfficialAccount` de Alanya-admin).
 * `accountType: 2` est SA valeur « officiel », qui allume le badge ; chez nous
 * l'officiel se lit dans `typeCompte` (5).
 */
export function presenterCompteOfficiel(c: Compte) {
  return {
    alanyaID: c.id,
    nom: c.nom,
    pseudo: c.pseudo,
    alanyaPhone: c.publicNumber,
    email: null,
    avatarUrl: c.avatarUrl,
    typeCompte: c.typeCompte,
    accountType: 2,
    verificationStatus: 0,
    createdAt: c.createdAt,
    idPays: c.idPays,
  };
}

/**
 * Crée le compte officiel. Lève 409 s'il existe déjà.
 *
 * ⚠️ VERROU CONSULTATIF DANS LA TRANSACTION : deux clics, ou deux onglets,
 * ne doivent pas créer deux comptes officiels. Sans le verrou, les deux
 * lectures « aucun compte » passeraient avant la première écriture.
 *
 * Aucun e-mail, aucun mobile, aucun mot de passe : aucune voie de connexion
 * ne mène à ce compte. Sa photo est le logo servi par ce serveur même
 * (`public/logo-alanya-officiel.png` : le logo sur FOND BLANC, avec une marge
 * pour le rond de l'avatar — le logo transparent disparaissait sur fond
 * sombre), en URL absolue comme toute photo en base.
 */
export async function creerCompteOfficiel() {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('gestion:compte-officiel'))`;
    const existant = await tx.user.findFirst({
      where: { typeCompte: TYPE_COMPTE_OFFICIEL, isDelete: false },
      select: { id: true },
    });
    if (existant) {
      throw new ErreurAdmin(409, "Un compte officiel existe déjà", "OFFICIAL_ALREADY_EXISTS");
    }
    return tx.user.create({
      data: {
        nom: NOM_COMPTE_OFFICIEL,
        pseudo: "alanyawork",
        publicNumber: await generateUniquePublicNumber(),
        typeCompte: TYPE_COMPTE_OFFICIEL,
        avatarUrl: `${env.publicBaseUrl}/logo-alanya-officiel.png`,
      },
      select: CHAMPS,
    });
  });
}
