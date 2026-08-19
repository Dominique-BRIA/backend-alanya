import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createRingtoneSchema } from "@/lib/validation";
import { catalogueDe, jsonSonnerie } from "@/lib/ringtones";
// `estDoublonUnique` vit chez les listes de contacts mais ne parle que de
// Prisma : il reconnait un P2002, quelle que soit la table. Le reecrire ici
// donnerait deux lectures du meme code d'erreur a garder d'accord.
import { estDoublonUnique } from "@/lib/contact-lists";

// GET /api/ringtones — le catalogue de l'utilisateur connecte, de la plus
// ancienne a la plus recente. L'ordre est contractuel, voir ORDRE_SONNERIES.
export const GET = withAuth(async (_req: NextRequest, userId: string) => {
  const ringtones = await catalogueDe(userId);

  // Les entrees sont rendues telles quelles, sans verifier que chaque media
  // existe encore. Ce serait une requete par ligne pour un cas rare, et cela ne
  // reglerait rien : le media peut disparaitre entre cette lecture et le moment
  // ou le client joue le son. C'est donc au client d'ecarter ce que
  // GET /api/media/<id> lui rend en 404 — voir l'en-tete de la migration
  // 20260819_catalogue_sonneries.
  return ok({ ringtones: ringtones.map(jsonSonnerie) });
});

// POST /api/ringtones — inscrit au catalogue un media deja televerse.
//
// 201 pour une nouvelle entree, 200 quand l'url est deja au catalogue : le
// libelle est alors mis a jour et la ligne EXISTANTE rendue. Un catalogue est un
// ensemble de medias, pas un journal d'imports.
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const data = createRingtoneSchema.parse(await req.json());

  const existante = await prisma.userRingtone.findUnique({
    where: { userId_url: { userId, url: data.url } },
    select: { id: true },
  });

  // Le `where` porte sur (userId, url) et pas sur l'url seule : deux comptes
  // peuvent parfaitement avoir importe le meme media, et chacun le renomme chez
  // lui sans toucher au catalogue de l'autre.
  if (existante) {
    const sonnerie = await prisma.userRingtone.update({
      where: { id: existante.id },
      data: { label: data.label },
    });
    return ok({ ringtone: jsonSonnerie(sonnerie) });
  }

  try {
    const sonnerie = await prisma.userRingtone.create({
      data: { userId, url: data.url, label: data.label },
    });
    return ok({ ringtone: jsonSonnerie(sonnerie) }, 201);
  } catch (err) {
    // Garde-fou apres la verification explicite : entre la lecture et
    // l'ecriture, un autre appareil du meme compte a pu inscrire la meme url.
    // C'est encore un renommage, pas une erreur a remonter — et surtout pas un
    // doublon a laisser passer.
    if (estDoublonUnique(err)) {
      const sonnerie = await prisma.userRingtone.update({
        where: { userId_url: { userId, url: data.url } },
        data: { label: data.label },
      });
      return ok({ ringtone: jsonSonnerie(sonnerie) });
    }
    throw err;
  }
});
