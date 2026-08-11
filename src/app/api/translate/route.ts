import { type NextRequest } from "next/server";
import { ok, fail } from "@/lib/http";
import { withAuth } from "@/lib/auth-context";
import {
  codeLangueValide,
  fournisseur,
  fournisseurParDefaut,
  type Fournisseur,
} from "@/lib/traduction-fournisseurs";

/**
 * POST /api/translate — relais de traduction des messages.
 *
 * POURQUOI UN RELAIS. Une cle d'API placee dans le navigateur est publique :
 * n'importe qui ouvre les outils de developpement, la lit, et la facture sur
 * notre compte. Azure exige d'ailleurs la cle en en-tete et sa documentation
 * interdit de la poser dans du JavaScript client. Le client n'appelle donc
 * jamais le fournisseur : il nous appelle, nous.
 *
 * Trois choses vivent ici et nulle part ailleurs :
 *  - les cles, qui restent sur le VPS ;
 *  - le quota par compte, sans lequel un seul utilisateur peut facturer des
 *    milliers d'euros en une nuit ;
 *  - le cache partage, qui fait qu'un message de groupe lu par cinq personnes
 *    vers la meme langue n'est facture qu'une fois. C'est le second levier de
 *    cout, apres le moteur local du navigateur.
 *
 * CE QUI A CHANGE. Le relais servait le seul Azure. Il sert maintenant tout
 * fournisseur decrit dans `@/lib/traduction-fournisseurs` — c'est ce fichier
 * qui documente les variables d'environnement et porte les adaptateurs. Le
 * client nomme son choix dans la requete ; le serveur le valide contre ce qui
 * est REELLEMENT configure, et refuse plutot que de former un appel a moitie.
 *
 * Le quota et le cache restent communs a tous les fournisseurs : ils protegent
 * la facture, qui est commune elle aussi.
 */

/** Au-dela, ce n'est plus un message mais un document. */
const TEXTE_MAX = 5000;
/**
 * Un lot couvre l'ecran, pas la conversation. Vingt tient sous la limite la
 * plus basse des fournisseurs servis (DeepL en accepte cinquante, Google cent
 * vingt-huit, Azure mille) : aucun adaptateur n'a donc a refendre le lot.
 */
const LOT_MAX = 20;
/** Par compte et par jour. Genereux pour un lecteur, serre pour un script. */
const QUOTA_JOUR = Number.parseInt(process.env.TRANSLATE_QUOTA_JOUR ?? "", 10) || 50_000;

/**
 * Cache et quota en memoire.
 *
 * Volontairement PAS en base : aucune migration, et ces deux tables n'ont
 * aucune valeur a conserver au-dela d'un redemarrage — le pire qu'il arrive
 * est de repayer une traduction deja payee, et de rendre son quota a quelqu'un.
 * Le jour ou le service tournera sur plusieurs instances, il faudra les
 * deplacer dans Redis : ce commentaire est la pour qu'on s'en souvienne.
 */
const cache = new Map<string, { texte: string; source: string; moteur: string }>();
const CACHE_MAX = 50_000;
const quotas = new Map<string, { jour: string; caracteres: number }>();

/**
 * La cle de cache porte le FOURNISSEUR en tete.
 *
 * Deux moteurs ne rendent pas la meme traduction du meme texte. Les melanger
 * ferait changer une bulle deja lue sans qu'aucune action de l'utilisateur ne
 * l'explique — et rendrait le choix des Parametres sans effet visible tant que
 * le cache repond. Le prix a payer est une entree par moteur, ce qui est
 * exactement ce que l'on veut.
 */
function cleCache(moteur: string, empreinte: string, source: string, cible: string): string {
  return `${moteur}|${empreinte}|${source}|${cible}`;
}

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

/**
 * Rend le quota debite avant un appel qui a echoue.
 *
 * ⚠️ FONCTION MANQUANTE, qui cassait la compilation : le chemin d'erreur
 * l'appelait sans qu'elle existe (`TS2304: Cannot find name 'rendre'`), et
 * `npm run build` echouait donc completement. Ecrite en miroir de `consommer`.
 *
 * Le controle du jour n'est pas une precaution de style : si minuit tombe entre
 * le debit et l'echec, le compteur a deja ete remis a zero pour la journee
 * suivante. Rendre alors des caracteres reviendrait a creer du quota negatif —
 * l'utilisateur commencerait sa journee avec un credit qu'il n'a jamais paye.
 * Le plancher a zero couvre le meme accident dans l'autre sens.
 */
function rendre(userId: string, caracteres: number): void {
  const jour = jourCourant();
  const actuel = quotas.get(userId);
  if (!actuel || actuel.jour !== jour) return;
  quotas.set(userId, {
    jour,
    caracteres: Math.max(0, actuel.caracteres - caracteres),
  });
}

function retenir(cle: string, valeur: { texte: string; source: string; moteur: string }) {
  // Eviction grossiere : on vide la moitie la plus ancienne quand c'est plein.
  // Une LRU exacte ne vaut pas sa complexite pour un cache qu'un redemarrage
  // efface de toute facon.
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

/**
 * Resout le fournisseur demande.
 *
 * Rend soit le fournisseur, soit la reponse d'erreur a renvoyer telle quelle.
 * Un nom inconnu est une erreur du CLIENT (400) ; une cle absente est une
 * indisponibilite du SERVICE (502), que le client sait deja mettre en pause.
 */
function resoudre(demande: string): { f: Fournisseur } | { erreur: Response } {
  if (!demande) {
    const defaut = fournisseurParDefaut();
    if (!defaut) {
      return { erreur: fail("Traduction en ligne indisponible", 502, "PROVIDER_UNAVAILABLE") };
    }
    return { f: defaut };
  }

  const f = fournisseur(demande);
  if (!f) return { erreur: fail("Moteur de traduction inconnu", 400, "PROVIDER_UNKNOWN") };
  // Le moteur du navigateur ne passe pas par nous : le demander ici est un bug
  // du client, pas une panne. On le dit clairement plutot que de tenter un
  // appel sortant qui n'a aucun sens.
  if (f.surAppareil) {
    return { erreur: fail("Ce moteur s'execute sur l'appareil", 400, "PROVIDER_LOCAL") };
  }
  if (!f.configure() || !f.traduire) {
    return { erreur: fail("Moteur de traduction indisponible", 502, "PROVIDER_UNAVAILABLE") };
  }
  return { f };
}

export const POST = withAuth(async (req: NextRequest, userId: string) => {
  const corps = await req.json().catch(() => null);
  const cible = typeof corps?.target === "string" ? corps.target.trim().toLowerCase() : "";
  const demande = typeof corps?.provider === "string" ? corps.provider.trim().toLowerCase() : "";
  const items: Element[] = Array.isArray(corps?.items) ? corps.items : [];

  if (!cible || items.length === 0) return fail("Requete invalide", 400, "BAD_REQUEST");
  // Forme du code verifiee avant toute sortie reseau. Le catalogue exact reste
  // l'affaire du fournisseur : le figer ici serait faux a la premiere evolution.
  if (!codeLangueValide(cible)) return fail("Langue cible invalide", 400, "BAD_REQUEST");
  if (items.length > LOT_MAX) return fail("Lot trop grand", 413, "TOO_MANY");

  const resolu = resoudre(demande);
  if ("erreur" in resolu) return resolu.erreur;
  const moteur = resolu.f;

  const valides = items.filter(
    (i) =>
      i &&
      typeof i.empreinte === "string" &&
      typeof i.texte === "string" &&
      i.texte.trim().length > 0 &&
      i.texte.length <= TEXTE_MAX &&
      (i.source === undefined || (typeof i.source === "string" && codeLangueValide(i.source))),
  );
  if (valides.length === 0) return fail("Requete invalide", 400, "BAD_REQUEST");

  // Le cache d'abord : ce qui en sort ne coute rien et n'entame aucun quota.
  const resultats = new Map<string, { texte: string; source: string; moteur: string }>();
  const aTraduire: Element[] = [];
  for (const item of valides) {
    const connu = cache.get(cleCache(moteur.id, item.texte, item.source ?? "", cible));
    if (connu) resultats.set(item.empreinte, connu);
    else aTraduire.push(item);
  }

  if (aTraduire.length > 0) {
    const caracteres = aTraduire.reduce((n, i) => n + i.texte.length, 0);
    if (!consommer(userId, caracteres)) {
      // On dit quand reessayer plutot que de laisser deviner.
      return fail("Quota de traduction atteint pour aujourd'hui", 429, "QUOTA");
    }

    // Un seul appel pour tout ce qui partage la meme langue source declaree.
    const parSource = new Map<string, Element[]>();
    for (const item of aTraduire) {
      const cle = item.source ?? "";
      parSource.set(cle, [...(parSource.get(cle) ?? []), item]);
    }

    try {
      for (const [source, lot] of parSource) {
        // Traduction des codes de langue au dialecte du moteur, juste avant
        // l'appel : le cache et la reponse gardent les codes de l'application.
        const traduits = await moteur.traduire!(
          lot.map((i) => i.texte),
          moteur.langue(cible),
          source ? moteur.langue(source) : undefined,
        );
        lot.forEach((item, index) => {
          const t = traduits[index];
          if (!t?.texte) return;
          // La source rendue par le moteur est un code a LUI (« zh-Hans »,
          // « NB »...). On lui prefere celle que l'appelant a declaree, et a
          // defaut on la ramene au code de l'application : la reponse parle
          // les memes codes que la requete, quel que soit le moteur.
          const valeur = {
            texte: t.texte,
            source: source || moteur.codeApplication(t.source),
            moteur: moteur.id,
          };
          resultats.set(item.empreinte, valeur);
          retenir(cleCache(moteur.id, item.texte, item.source ?? "", cible), valeur);
        });
      }
    } catch {
      // L'exception ne porte que le nom du moteur et un code HTTP (voir
      // `appeler` dans le registre) : rien du texte envoye ne peut fuir ici.
      //
      // Le quota a ete debite AVANT l'appel : on le rend, sinon une panne du
      // fournisseur amputerait la journee de quelqu'un qui n'a rien recu.
      rendre(userId, caracteres);
      return fail("Service de traduction indisponible", 502, "PROVIDER_UNAVAILABLE");
    }
  }

  // Journalisation volontairement muette sur le contenu : on mesure le volume,
  // le taux de cache et le moteur, jamais ce qui est ecrit.
  // eslint-disable-next-line no-console
  console.log(
    `[translate] ${userId.slice(0, 8)} moteur=${moteur.id} lot=${valides.length} cache=${valides.length - aTraduire.length} cible=${cible}`,
  );

  return ok({
    results: valides
      .map((i) => {
        const r = resultats.get(i.empreinte);
        return r
          ? { empreinte: i.empreinte, texte: r.texte, source: r.source, moteur: r.moteur }
          : null;
      })
      .filter(Boolean),
  });
});
