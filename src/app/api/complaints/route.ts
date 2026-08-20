import { type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import { createComplaintSchema } from "@/lib/validation";
import { estDoublonUnique } from "@/lib/contact-lists";

/**
 * POST /api/complaints — dépose la plainte vocale dictée sur la touche 0 d'un
 * centre vocal.
 *
 * Le fichier est DÉJÀ téléversé quand on arrive ici : le client passe par
 * `POST /api/media`, comme pour un message vocal, et n'envoie que la référence.
 * Refaire un chemin de téléversement pour cette seule fonction aurait dupliqué
 * la gestion du multipart, des types MIME et du stockage.
 *
 * 🔴 L'ENVOI EST IDEMPOTENT PAR CONSTRUCTION. `cleEnvoi` est posée par le client,
 * une par enregistrement, et l'unicité est tenue par un index en base. Deux
 * envois du même fichier — réseau qui hésite, double appui, réessai après une
 * réponse perdue — ne peuvent pas produire deux plaintes. C'est le point §5 du
 * cahier des charges, et il est réglé par une CONTRAINTE et non par du code
 * qu'un chemin oublié pourrait contourner. Le second envoi rend **200 avec la
 * plainte existante** : du point de vue de l'appelant, sa plainte est bien
 * partie, ce qui est vrai — lui renvoyer une erreur l'inviterait à recommencer.
 */
export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const data = createComplaintSchema.parse(await req.json());

  // Le centre est relu, jamais cru sur parole : le client envoie un
  // identifiant, et rien ne l'empêcherait d'en envoyer un autre. On vérifie
  // que c'est bien un CENTRE VOCAL, sinon la plainte atterrirait chez un
  // particulier qui n'a aucun moyen de la lire.
  const centre = await prisma.user.findUnique({
    where: { id: data.centerId },
    select: { id: true, typeCompte: true, idCompany: true },
  });
  if (!centre) return fail("Centre vocal introuvable", 404, "NOT_FOUND");
  if (Number(centre.typeCompte) !== 4) {
    return fail("Ce numéro n'est pas un centre vocal", 400, "NOT_VOICE_CENTER");
  }
  // ⚠️ L'entreprise vient du CENTRE et non de l'appelant : c'est elle qui devra
  // traiter la plainte. Un appelant peut n'appartenir à aucune entreprise —
  // 52 comptes sur 62 sont dans ce cas — et la sienne, s'il en a une, n'a rien
  // à voir avec le standard qu'il vient d'appeler.
  if (centre.idCompany == null) {
    return fail("Ce centre vocal n'a pas d'entreprise", 409, "NO_COMPANY");
  }

  // Le média doit exister ET appartenir à l'appelant. Sans ce second contrôle,
  // n'importe qui pourrait rattacher le vocal d'un autre à une plainte.
  const media = await prisma.mediaFile.findUnique({
    where: { id: data.mediaId },
    select: { id: true, ownerId: true, durationMs: true },
  });
  if (!media) return fail("Enregistrement introuvable", 404, "MEDIA_NOT_FOUND");
  if (media.ownerId !== userId) {
    return fail("Enregistrement refusé", 403, "FORBIDDEN");
  }

  try {
    const plainte = await prisma.voiceComplaint.create({
      data: {
        idCompany: centre.idCompany,
        center_alanyaID: centre.id,
        userId,
        mediaId: media.id,
        // La durée annoncée par le client fait foi si elle est présente, sinon
        // celle mesurée au téléversement. Les deux peuvent manquer : le défaut
        // à 0 vaut « non mesurée », jamais « vide ».
        dureeMs: data.dureeMs ?? media.durationMs ?? 0,
        cleEnvoi: data.cleEnvoi,
      },
      select: { idComplaint: true, createdAt: true, statut: true },
    });
    return ok({ complaint: plainte }, 201);
  } catch (err) {
    // Même clé : c'est un réessai, pas une erreur. On rend la plainte DÉJÀ
    // enregistrée, avec 200 — voir l'en-tête.
    if (estDoublonUnique(err)) {
      const existante = await prisma.voiceComplaint.findUnique({
        where: { cleEnvoi: data.cleEnvoi },
        select: { idComplaint: true, createdAt: true, statut: true },
      });
      if (existante) return ok({ complaint: existante });
    }
    throw err;
  }
});
