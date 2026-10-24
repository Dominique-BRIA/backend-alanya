import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { invaliderProfil } from "@/lib/cache-redis.mjs";
import { routeAdmin } from "@/lib/gestion/session";
import { profilDeSession } from "@/lib/gestion/profil";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";

/** GET /api/admin/me — le profil et les permissions de l'administrateur connecté. */
export const GET = routeAdmin("profile.read", async (_req, session) => okAdmin(await profilDeSession(session)));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const corpsSchema = z.object({
  nom: z.string().max(100).optional(),
  pseudo: z.string().max(50).optional(),
  email: z.string().max(100).nullable().optional(),
  avatarUrl: z.string().max(4000).nullable().optional(),
  idPays: z.coerce.number().int().positive().nullable().optional(),
});

/**
 * PUT /api/admin/me — nom, pseudo, e-mail, avatar, pays : leur `updateMe`,
 * règle pour règle (champ vide refusé, e-mail unique, au moins un champ).
 *
 * C'est le compte Alanya de l'administrateur : ce qui change ici change aussi
 * dans l'application.
 */
export const PUT = routeAdmin("profile.update", async (req, session) => {
  const corps = corpsSchema.safeParse(await req.json().catch(() => null));
  if (!corps.success) throw new ErreurAdmin(400, "Données invalides", "VALIDATION");
  const { nom, pseudo, email, avatarUrl, idPays } = corps.data;
  const data: { nom?: string; pseudo?: string; email?: string | null; avatarUrl?: string | null; idPays?: number | null } = {};

  if (nom !== undefined) {
    if (!nom.trim()) throw new ErreurAdmin(400, "Le nom ne peut pas être vide", "FIELD_EMPTY");
    data.nom = nom.trim();
  }
  if (pseudo !== undefined) {
    if (!pseudo.trim()) throw new ErreurAdmin(400, "Le pseudo ne peut pas être vide", "FIELD_EMPTY");
    data.pseudo = pseudo.trim();
  }
  if (email !== undefined) {
    if (email) {
      if (!EMAIL_RE.test(email)) throw new ErreurAdmin(400, "Adresse email invalide", "INVALID_EMAIL");
      const normalise = email.toLowerCase().trim();
      const prise = await prisma.user.findFirst({
        where: { email: normalise, NOT: { id: session.userId } },
        select: { id: true },
      });
      if (prise) throw new ErreurAdmin(409, "Cette adresse email est déjà utilisée", "EMAIL_TAKEN");
      data.email = normalise;
    } else {
      data.email = null;
    }
  }
  if (avatarUrl !== undefined) data.avatarUrl = avatarUrl || null;
  if (idPays !== undefined) {
    if (idPays) {
      const pays = await prisma.pays.findUnique({ where: { idPays } });
      if (!pays) throw new ErreurAdmin(400, "Pays invalide", "INVALID_COUNTRY");
    }
    data.idPays = idPays || null;
  }
  if (Object.keys(data).length === 0) {
    throw new ErreurAdmin(400, "Aucun champ à modifier", "NO_FIELDS_TO_UPDATE");
  }

  await prisma.user.update({ where: { id: session.userId }, data });
  // Le profil est mis en cache côté application : le nom changé doit s'y voir.
  await invaliderProfil(session.userId);
  return okAdmin(await profilDeSession(session));
});
