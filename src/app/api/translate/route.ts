import { createHash } from "node:crypto";
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
 * Empreinte du texte, CALCULEE ICI.
 *
 * ⚠️ Point de securite, et la raison d'etre de cette fonction. Le client envoie
 * une empreinte avec chaque element ; elle ne doit JAMAIS servir a indexer le
 * cache, qui est partage entre tous les comptes. Un client modifie n'aurait
 * qu'a poster « Rendez-vous annule » sous l'empreinte d'un vrai message pour
 * que la personne suivante lise cette phrase-la a la place de la traduction du
 * sien. L'empreinte du client ne sert donc plus qu'a CORRELER la reponse a la
 * requete — c'est un numero de ticket, pas une cle.
 *
 * SHA-256 tronque a 128 bits : de quoi rendre une collision hors de portee,
 * pour une cle deux fois plus courte. Le texte est normalise en NFC pour que
 * deux ecritures Unicode du meme mot ne fassent pas deux entrees.
 */
function empreinteServeur(texte: string): string {
  return createHash("sha256").update(texte.normalize("NFC")).digest("hex").slice(0, 32);
}

/**
 * La cle de cache porte le FOURNISSEUR en tete.
 *
 * Deux moteurs ne rendent pas la meme traduction du meme texte. Les melanger
 * ferait changer une bulle deja lue sans qu'aucune action de l'utilisateur ne
 * l'explique — et rendrait le choix des Parametres sans effet visible tant que
 * le cache repond. Le prix a payer est une entree par moteur, ce qui est
 * exactement ce que l'on veut.
 *
 * `empreinte` est toujours celle d'`empreinteServeur`, jamais celle du client.
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
  /**
   * Identifiant de correlation choisi par le client, rendu tel quel dans la
   * reponse pour qu'il retrouve ses elements. N'entre dans AUCUNE cle : voir
   * `empreinteServeur`.
   */
  empreinte: string;
  texte: string;
  source?: string;
}

/** Un element et la cle de cache que le SERVEUR lui a calculee. */
interface Prepare {
  item: Element;
  cle: string;
}

/**
 * Longueur maximale de l'identifiant de correlation. Il repart dans la reponse
 * tel qu'il est arrive : on borne ce qu'un client peut nous faire recopier.
 */
const EMPREINTE_MAX = 128;

/**
 * Resout le fournisseur demande.
 *
 * Rend soit le fournisseur, soit la reponse d'erreur a renvoyer telle quelle.
 * Un nom inconnu est une erreur du CLIENT (400) ; une cle absente est une
 * indisponibilite du SERVICE (502).
 *
 * ⚠️ `PROVIDER_UNAVAILABLE` ne sort QUE d'ici, et signifie une seule chose :
 * ce serveur ne sert pas ce moteur — la cle n'est pas configuree. C'est un etat
 * PERMANENT : reessayer dans trente secondes echouera pareil, la seule issue
 * est de changer de moteur dans les Parametres. L'echec d'un appel au
 * fournisseur, lui, est PASSAGER et porte `PROVIDER_FAILED` (voir plus bas).
 * Confondre les deux faisait mettre le relais en pause pour une panne qui
 * n'existait pas, et proposer « reessayer » la ou il fallait « changer de
 * moteur ».
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
      i.empreinte.length > 0 &&
      i.empreinte.length <= EMPREINTE_MAX &&
      typeof i.texte === "string" &&
      i.texte.trim().length > 0 &&
      i.texte.length <= TEXTE_MAX &&
      (i.source === undefined || (typeof i.source === "string" && codeLangueValide(i.source))),
  );
  if (valides.length === 0) return fail("Requete invalide", 400, "BAD_REQUEST");

  // La cle de cache est calculee UNE fois par element, a partir du texte recu.
  // Rien de ce que le client raconte n'y entre.
  const prepares: Prepare[] = valides.map((item) => ({
    item,
    cle: cleCache(moteur.id, empreinteServeur(item.texte), item.source ?? "", cible),
  }));

  // Le cache d'abord : ce qui en sort ne coute rien et n'entame aucun quota.
  // Les resultats sont indexes par CLE DE CACHE et non par l'identifiant du
  // client : deux elements portant le meme identifiant — par negligence ou a
  // dessein — ne peuvent donc pas se voler leur traduction.
  const resultats = new Map<string, { texte: string; source: string; moteur: string }>();
  const aTraduire: Prepare[] = [];
  const dejaDemande = new Set<string>();
  for (const prepare of prepares) {
    const connu = cache.get(prepare.cle);
    if (connu) {
      resultats.set(prepare.cle, connu);
      continue;
    }
    // Deux fois le meme texte dans un lot — un « ok » repete, un message
    // transfere — ne part qu'une fois, et n'est facture qu'une fois.
    if (dejaDemande.has(prepare.cle)) continue;
    dejaDemande.add(prepare.cle);
    aTraduire.push(prepare);
  }
  // Compte fige avant l'appel : `resultats` va se remplir, et le taux de cache
  // mesure ce qui a ete evite, pas ce qui a fini par arriver.
  const depuisCache = resultats.size;

  if (aTraduire.length > 0) {
    const caracteres = aTraduire.reduce((n, p) => n + p.item.texte.length, 0);
    if (!consommer(userId, caracteres)) {
      // On dit quand reessayer plutot que de laisser deviner.
      return fail("Quota de traduction atteint pour aujourd'hui", 429, "QUOTA");
    }

    // Un seul appel pour tout ce qui partage la meme langue source declaree.
    const parSource = new Map<string, Prepare[]>();
    for (const prepare of aTraduire) {
      const cle = prepare.item.source ?? "";
      parSource.set(cle, [...(parSource.get(cle) ?? []), prepare]);
    }

    try {
      for (const [source, lot] of parSource) {
        // Traduction des codes de langue au dialecte du moteur, juste avant
        // l'appel : le cache et la reponse gardent les codes de l'application.
        const traduits = await moteur.traduire!(
          lot.map((p) => p.item.texte),
          moteur.langue(cible),
          source ? moteur.langue(source) : undefined,
        );
        lot.forEach((prepare, index) => {
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
          resultats.set(prepare.cle, valeur);
          retenir(prepare.cle, valeur);
        });
      }
    } catch {
      // L'exception ne porte que le nom du moteur et un code HTTP (voir
      // `appeler` dans le registre) : rien du texte envoye ne peut fuir ici.
      //
      // Le quota a ete debite AVANT l'appel : on rend ce qui n'a pas ete
      // traduit, sinon une panne du fournisseur amputerait la journee de
      // quelqu'un qui n'a rien recu.
      //
      // On ne rend PAS le lot entier : quand les elements sont repartis en
      // plusieurs groupes de langue source, un groupe a pu aboutir avant que le
      // suivant echoue. Celui-la a bien ete facture par le fournisseur, et sa
      // traduction est desormais dans le cache partage — la rembourser serait
      // offrir du quota pour un travail reellement paye.
      rendre(
        userId,
        aTraduire.filter((p) => !resultats.has(p.cle)).reduce((n, p) => n + p.item.texte.length, 0),
      );
      // PASSAGER, et c'est tout l'interet de ne pas dire `PROVIDER_UNAVAILABLE`
      // ici : le moteur est bien servi par ce serveur, c'est l'appel qui a
      // echoue. Le client peut donc mettre le relais en pause quelques secondes
      // et reessayer, au lieu d'envoyer l'utilisateur changer de moteur.
      return fail("Service de traduction indisponible", 502, "PROVIDER_FAILED");
    }
  }

  // Journalisation volontairement muette sur le contenu : on mesure le volume,
  // le taux de cache et le moteur, jamais ce qui est ecrit.
  // eslint-disable-next-line no-console
  console.log(
    `[translate] ${userId.slice(0, 8)} moteur=${moteur.id} lot=${prepares.length} cache=${depuisCache} appels=${aTraduire.length} cible=${cible}`,
  );

  // Chaque element repart avec l'identifiant que le CLIENT lui avait donne :
  // c'est la seule chose que nous en faisons, et elle ne touche a rien de
  // partage. Le texte rendu, lui, vient de la cle calculee ici.
  return ok({
    results: prepares
      .map(({ item, cle }) => {
        const r = resultats.get(cle);
        return r
          ? { empreinte: item.empreinte, texte: r.texte, source: r.source, moteur: r.moteur }
          : null;
      })
      .filter(Boolean),
  });
});
