import { prisma } from "@/lib/prisma";
import { ErreurAdmin } from "./reponses";
import { permissionsDe } from "./permissions";
import { type SessionAdmin } from "./session";

/**
 * Le profil de l'administrateur connecté, dans la forme qu'attend la console
 * (`AdminProfile` d'Alanya2026/Alanya-admin, leur `getMe`).
 *
 * `typeCompte` y est le RÔLE (0/1/2), comme chez eux : c'est ce que la console
 * lit pour ouvrir ses écrans réservés. Chez nous il vient de `users.role_admin`,
 * pas de `users.type_compte` (voir `permissions.ts`).
 */
export async function profilAdmin(userId: string) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      nom: true,
      pseudo: true,
      email: true,
      publicNumber: true,
      avatarUrl: true,
      roleAdmin: true,
      createdAt: true,
      lastSeen: true,
      pays: { select: { libelle: true } },
    },
  });
  if (!u) throw new ErreurAdmin(404, "Profil introuvable", "PROFILE_NOT_FOUND");
  return {
    alanyaID: u.id,
    nom: u.nom,
    pseudo: u.pseudo,
    email: u.email,
    alanyaPhone: u.publicNumber,
    avatarUrl: u.avatarUrl,
    typeCompte: u.roleAdmin,
    permissions: permissionsDe(u.roleAdmin),
    paysLibelle: u.pays?.libelle ?? null,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
  };
}

export const profilDeSession = (session: SessionAdmin) => profilAdmin(session.userId);
