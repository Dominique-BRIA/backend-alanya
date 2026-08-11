import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";

/**
 * POST /api/translate — relais de traduction des messages.
 *
 * POURQUOI UN RELAIS. Une clé d'API placée dans le navigateur est publique :
 * n'importe qui ouvre les outils de développement, la lit, et la facture sur
 * notre compte. Azure exige d'ailleurs la clé en en-tête et sa documentation
 * interdit de la poser dans du JavaScript client. Le client n'appelle donc
 * jamais le fournisseur : il nous appelle, nous.
 *
 * Trois choses vivent ici et nulle part ailleurs :
 *  - la clé, qui reste sur le VPS ;
 *  - le quota par compte, sans lequel un seul utilisateur peut facturer des
 *    milliers d'euros en une nuit ;
 *  - le cache partagé, qui fait qu'un message de groupe lu par cinq personnes
 *    vers la même langue n'est facturé qu'une fois. C'est le second levier de
 *    coût, après le moteur local du navigateur.
 *
 * Le fournisseur se change par variable d'environnement, sans toucher au
 * client : c'est précisément ce que le relais achète.
 */

/** Azure par défaut : 10 $/M caractères, et aucune conservation des données. */
const FOURNISSEUR = process.env.TRANSLATE_PROVIDER ?? "azure";
const AZURE_CLE = process.env.AZURE_TRANSLATOR_KEY ?? "";
const AZURE_REGION = process.env.AZURE_TRANSLATOR_REGION ?? "";
const AZURE_URL =
  process.env.AZURE_TRANSLATOR_ENDPOINT ?? "https://api.cognitive.microsofttranslator.com";

/** Au-delà, ce n'est plus un message mais un document. */
const TEXTE_MAX = 5000;
/** Un lot couvre l'écran, pas la conversation. */
const LOT_MAX = 20;
/** Par compte et par jour. Généreux pour un lecteur, serré pour un script. */
const QUOTA_JOUR = 50_000;

/**
 * Cache et quota en mémoire.
 *
 * Volontairement PAS en base : aucune migration, et ces deux tables n'ont
 * aucune valeur à conserver au-delà d'un redémarrage — le pire qu'il arrive
 * est de repayer une traduction déjà payée, et de rendre son quota à quelqu'un.
 * Le jour où le service tournera sur plusieurs instances, il faudra les
 * déplacer dans Redis : ce commentaire est là pour qu'on s'en souvienne.
 */
const cache = new Map<string, { texte: string; source: string; moteur: string }>();
const CACHE_MAX = 50_000;
const quotas = new Map<string, { jour: string; caracteres: number }>();

function jourCourant(): string {
  return new Date().toISOString().slice(0, 10);
}

function consommer(userId: string, caracteres: number): boolean {
  const jour = jourCourant();
  const actuel = quotas.get(userId);
  const compte = actuel && actuel.jour === jour ? actuel.caracteres : 0;
  if (compte + caracteres > QUOTA_JOUR) return false;
  quotas.set(userId, { jour, caracteres: compte + caracteres });
  return true;
}

function retenir(cle: string, valeur: { texte: string; source: string; moteur: string }) {
  // Éviction grossière : on vide la moitié la plus ancienne quand c'est plein.
  // Une LRU exacte ne vaut pas sa complexité pour un cache qu'un redémarrage
  // efface de toute façon.
  if (cache.size >= CACHE_MAX) {
    const cles = [...cache.keys()].slice(0, Math.floor(CACHE_MAX / 2));
    for (const c of cles) cache.delete(c);
  }
  cache.set(cle, valeur);
}

interface Element {
  empreinte: string;
  texte: string;
  source?: string;
}

/** Appel Azure. Un seul aller-retour pour tout le lot restant. */
async function traduireAzure(
  textes: string[],
  cible: string,
  source?: string,
): Promise<{ texte: string; source: string }[]> {
  const url = new URL("/translate", AZURE_URL);
  url.searchParams.set("api-version", "3.0");
  url.searchParams.set("to", cible);
  if (source) url.searchParams.set("from", source);
  // Les messages sont du texte, jamais du balisage : le dire évite qu'Azure
  // interprète un chevron comme une balise et le mange.
  url.searchParams.set("textType", "plain");

  const reponse = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": AZURE_CLE,
      ...(AZURE_REGION ? { "Ocp-Apim-Subscription-Region": AZURE_REGION } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(textes.map((texte) => ({ Text: texte }))),
  });

  if (!reponse.ok) {
    // On ne relaie PAS le corps de l'erreur : il peut contenir le texte envoyé,
    // et cette réponse part chez le client.
    throw new Error(`azure ${reponse.status}`);
  }

  const donnees = (await reponse.json()) as Array<{
    detectedLanguage?: { language: string };
    translations: Array<{ text: string }>;
  }>;
  return donnees.map((d) => ({
    texte: d.translations?.[0]?.text ?? "",
    source: source ?? d.detectedLanguage?.language ?? "",
  }));
}

export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const corps = await req.json().catch(() => null);
  const cible = typeof corps?.target === "string" ? corps.target.trim().toLowerCase() : "";
  const items: Element[] = Array.isArray(corps?.items) ? corps.items : [];

  if (!cible || items.length === 0) return fail("Requête invalide", 400, "BAD_REQUEST");
  if (items.length > LOT_MAX) return fail("Lot trop grand", 413, "TOO_MANY");

  const valides = items.filter(
    (i) =>
      i &&
      typeof i.empreinte === "string" &&
      typeof i.texte === "string" &&
      i.texte.trim().length > 0 &&
      i.texte.length <= TEXTE_MAX,
  );
  if (valides.length === 0) return fail("Requête invalide", 400, "BAD_REQUEST");

  // Le cache d'abord : ce qui en sort ne coûte rien et n'entame aucun quota.
  const resultats = new Map<string, { texte: string; source: string; moteur: string }>();
  const aTraduire: Element[] = [];
  for (const item of valides) {
    const cle = `${item.empreinte}|${item.source ?? ""}|${cible}`;
    const connu = cache.get(cle);
    if (connu) resultats.set(item.empreinte, connu);
    else aTraduire.push(item);
  }

  if (aTraduire.length > 0) {
    if (FOURNISSEUR !== "azure" || !AZURE_CLE) {
      return fail("Traduction en ligne indisponible", 502, "PROVIDER_UNAVAILABLE");
    }
    const caracteres = aTraduire.reduce((n, i) => n + i.texte.length, 0);
    if (!consommer(userId, caracteres)) {
      // On dit quand réessayer plutôt que de laisser deviner.
      return fail("Quota de traduction atteint pour aujourd'hui", 429, "QUOTA");
    }

    // Un seul appel pour tout ce qui partage la même langue source déclarée.
    const parSource = new Map<string, Element[]>();
    for (const item of aTraduire) {
      const cle = item.source ?? "";
      parSource.set(cle, [...(parSource.get(cle) ?? []), item]);
    }

    try {
      for (const [source, lot] of parSource) {
        const traduits = await traduireAzure(
          lot.map((i) => i.texte),
          cible,
          source || undefined,
        );
        lot.forEach((item, index) => {
          const t = traduits[index];
          if (!t?.texte) return;
          const valeur = { texte: t.texte, source: t.source, moteur: "azure" };
          resultats.set(item.empreinte, valeur);
          retenir(`${item.empreinte}|${item.source ?? ""}|${cible}`, valeur);
        });
      }
    } catch {
      return fail("Service de traduction indisponible", 502, "PROVIDER_UNAVAILABLE");
    }
  }

  // Journalisation volontairement muette sur le contenu : on mesure le volume
  // et le taux de cache, jamais ce qui est écrit.
  // eslint-disable-next-line no-console
  console.log(
    `[translate] ${userId.slice(0, 8)} lot=${valides.length} cache=${valides.length - aTraduire.length} cible=${cible}`,
  );

  return ok({
    results: valides
      .map((i) => {
        const r = resultats.get(i.empreinte);
        return r ? { empreinte: i.empreinte, texte: r.texte, source: r.source, moteur: r.moteur } : null;
      })
      .filter(Boolean),
  });
});
