import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { pagination } from "@/lib/gestion/outils";
import { numeroCanonique } from "@/lib/gestion/comptes";
import { ALANYA_ID_REGEX } from "@/lib/validation";

/**
 * Les numéros Alanya RÉSERVÉS (`reserved_alanya_phone`) : la génération
 * automatique ne les tire jamais ; seule la console peut les attribuer.
 *
 * GET ?page&limit&q&available=0|1 — avec, pour chacun, le compte qui le porte.
 */
export const GET = routeAdmin("phones.read", async (req) => {
  const p = req.nextUrl.searchParams;
  const pg = pagination(p);
  const q = p.get("q")?.trim() ?? "";
  const chiffres = q.replace(/\D/g, "");
  const where: Prisma.ReservedAlanyaPhoneWhereInput = q
    ? chiffres
      ? { phoneCanonical: { startsWith: chiffres } }
      : { label: { contains: q, mode: "insensitive" } }
    : {};
  const tous = await prisma.reservedAlanyaPhone.findMany({
    where,
    orderBy: { phoneCanonical: "asc" },
    include: { creator: { select: { nom: true, pseudo: true } } },
  });
  const porteurs = await prisma.user.findMany({
    where: { publicNumber: { in: tous.map((r) => r.phoneCanonical) } },
    select: { id: true, nom: true, pseudo: true, publicNumber: true },
  });
  const parNumero = new Map(porteurs.map((u) => [u.publicNumber, u]));
  const disponible = p.get("available");
  const filtres = tous.filter((r) =>
    disponible === "1" ? !parNumero.has(r.phoneCanonical) : disponible === "0" ? parNumero.has(r.phoneCanonical) : true,
  );
  return okAdmin({
    items: filtres.slice(pg.skip, pg.skip + pg.limit).map((r) => {
      const u = parNumero.get(r.phoneCanonical);
      return {
        id: r.id,
        phone_canonical: r.phoneCanonical,
        label: r.label,
        created_by: r.createdBy,
        created_at: r.createdAt,
        created_by_nom: r.creator?.nom ?? null,
        is_used: !!u,
        used_by_alanya_id: u?.id ?? null,
        used_by_nom: u?.nom ?? null,
        used_by_pseudo: u?.pseudo ?? null,
      };
    }),
    total: filtres.length,
    page: pg.page,
    limit: pg.limit,
    pattern_suggestion: null,
  });
});

/** POST — `{ phone, label }` : réserve un numéro (409 s'il l'est déjà). */
export const POST = routeAdmin("phones.reserve", async (req, session) => {
  const corps = (await req.json().catch(() => ({}))) as { phone?: unknown; label?: unknown };
  const numero = numeroCanonique(String(corps?.phone ?? ""));
  // La colonne fait 8 caractères : les Alanya ID vont de 6 à 8 chiffres.
  if (!ALANYA_ID_REGEX.test(numero) || numero.length > 8) {
    throw new ErreurAdmin(400, "Numéro invalide : 6 à 8 chiffres", "INVALID_PHONE");
  }
  const label = String(corps?.label ?? "").trim().slice(0, 100) || "Réservé";
  session.audit = { cibleType: "reserved-alanya-phones", cibleId: numero };
  try {
    const r = await prisma.reservedAlanyaPhone.create({ data: { phoneCanonical: numero, label } });
    return okAdmin({ id: r.id, phone_canonical: r.phoneCanonical, label: r.label }, 201);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new ErreurAdmin(409, "Ce numéro est déjà réservé", "ALREADY_RESERVED");
    }
    throw e;
  }
});
