import { prisma } from "@/lib/prisma";
import { routeAdmin } from "@/lib/gestion/session";
import { ErreurAdmin, okAdmin } from "@/lib/gestion/reponses";
import { ecrireReglage, lireReglage } from "@/lib/gestion/outils";
import {
  CLE_REGLAGE_DEVELOPPEUR,
  ENSEIGNES_PAR_PERSONNE_PAR_DEFAUT,
} from "@/lib/developer/enseignes";

/**
 * GET / PUT /api/admin/developer-settings — l'espace développeur (07/11/2026).
 *
 * `enseignesParPersonne` : combien d'enseignes une personne peut créer depuis
 * la console développeur. 0 ferme la création (les enseignes existantes
 * continuent de marcher). Lu par `limiteDEnseignes()` à chaque création, donc
 * effectif aussitôt.
 *
 * La réponse dit aussi où en est l'espace : nombre d'enseignes, de personnes
 * qui en ont, et de personnes déjà à la limite — de quoi voir si la limite
 * gêne quelqu'un avant de la changer.
 */

const MAXIMUM = 100;

type ReglageDeveloppeur = { enseignesParPersonne: number };
const DEFAUT: ReglageDeveloppeur = { enseignesParPersonne: ENSEIGNES_PAR_PERSONNE_PAR_DEFAUT };

function normaliser(v: Partial<ReglageDeveloppeur>): ReglageDeveloppeur {
  const n = v.enseignesParPersonne;
  return {
    enseignesParPersonne:
      typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAXIMUM
        ? n
        : ENSEIGNES_PAR_PERSONNE_PAR_DEFAUT,
  };
}

async function etat() {
  const r = await lireReglage<ReglageDeveloppeur>(CLE_REGLAGE_DEVELOPPEUR, DEFAUT);
  const reglage = normaliser(r.valeur);
  const parPersonne = await prisma.developerAccount.groupBy({
    by: ["proprietaireId"],
    _count: { _all: true },
  });
  return {
    ...reglage,
    maximum: MAXIMUM,
    enseignes: parPersonne.reduce((s, p) => s + p._count._all, 0),
    personnes: parPersonne.length,
    personnesALaLimite: parPersonne.filter((p) => p._count._all >= reglage.enseignesParPersonne).length,
    modifieLe: r.modifieLe,
    modifiePar: r.modifiePar,
  };
}

export const GET = routeAdmin("settings.read", async () => okAdmin(await etat()));

export const PUT = routeAdmin("settings.write", async (req, session) => {
  const corps = ((await req.json().catch(() => null)) ?? {}) as { enseignesParPersonne?: unknown };
  const n = corps.enseignesParPersonne;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAXIMUM) {
    throw new ErreurAdmin(400, `Un nombre entier entre 0 et ${MAXIMUM} est attendu`, "FIELD_INVALID");
  }

  const actuel = normaliser((await lireReglage<ReglageDeveloppeur>(CLE_REGLAGE_DEVELOPPEUR, DEFAUT)).valeur);
  session.audit = {
    motif:
      n === actuel.enseignesParPersonne
        ? null
        : `enseignes par personne : ${actuel.enseignesParPersonne} → ${n}`,
  };
  await ecrireReglage(CLE_REGLAGE_DEVELOPPEUR, { enseignesParPersonne: n }, session);
  return okAdmin(await etat());
});
