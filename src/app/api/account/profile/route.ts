import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { updateProfileSchema } from "@/lib/validation";
import { nomAffichage } from "@/lib/display-name.mjs";
import { avatarPublicUrl, avatarStockage } from "@/lib/avatar";

// PATCH /api/account/profile — met à jour le profil de l'utilisateur connecté.
// F4 : écrit directement dans users (plus de table profiles).
export const PATCH = withAuth(async (req: NextRequest, userId: string) => {
  const data = updateProfileSchema.parse(await req.json());

  /*
   * Le pays doit EXISTER dans la table de référence. Le contrôle est le même
   * qu'à l'inscription (`/api/auth/setup`) : les clients lisent tous les deux
   * `GET /api/pays`, mais un identifiant inventé ne doit pas pouvoir entrer en
   * base par cette porte-ci alors que l'autre le refuse.
   */
  if (data.idPays != null) {
    const pays = await prisma.pays.findUnique({ where: { idPays: data.idPays } });
    if (!pays) return fail("Pays introuvable", 404, "PAYS_NOT_FOUND");
  }

  /*
   * 🔴 CETTE ROUTE NE TOUCHE NI `publicNumber` NI `mobile`, ET C'EST UNE RÈGLE.
   *
   * `publicNumber` est l'Alanya ID attribué à l'inscription : c'est l'identité
   * du compte, celle que les contacts ont enregistrée et par laquelle on
   * l'appelle. Rien dans les réglages ne doit pouvoir la changer.
   *
   * `mobile` non plus : changer de PAYS ne change pas de NUMÉRO. Un numéro
   * appartient à l'opérateur qui l'a attribué, pas au pays où l'on vit —
   * déménager en France en gardant sa ligne camerounaise est le cas normal, et
   * renormaliser sur le nouvel indicatif transformerait un numéro juste en
   * numéro faux. Le numéro se change ailleurs, sous mot de passe
   * (`POST /api/account/mobile`).
   *
   * ⚠️ La liste ci-dessous est une LISTE BLANCHE, champ par champ. Ne jamais la
   * remplacer par un `...data` : le jour où le schéma gagnera un champ, il
   * entrerait en base sans que personne ne l'ait décidé.
   */
  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(data.pseudo !== undefined && { pseudo: data.pseudo }),
      ...(data.avatarUrl !== undefined && { avatarUrl: avatarStockage(data.avatarUrl) }),
      ...(data.statusMsg !== undefined && { statusMsg: data.statusMsg }),
      ...(data.idPays !== undefined && { idPays: data.idPays }),
    },
  });

  return ok({
    pseudo: nomAffichage(user),
    avatarUrl: avatarPublicUrl(user.avatarUrl),
    statusMsg: user.statusMsg,
    idPays: user.idPays,
  });
});
