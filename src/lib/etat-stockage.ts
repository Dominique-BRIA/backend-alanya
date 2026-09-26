import { promises as fs } from "fs";
import { env } from "@/lib/env";
import { checkB2Connection } from "@/modules/media/b2";
import { checkB2PublicConnection, publicConfigure } from "@/modules/media/b2-public";
import { storageRoot, useCloudStorage as stockageNuage } from "@/modules/media/storage";

/**
 * L'ÉTAT DU STOCKAGE DES MÉDIAS, DIT À HAUTE VOIX.
 *
 * 🔴 UNE CLÉ BACKBLAZE FAUSSE NE SE VOIT NULLE PART. Le serveur démarre,
 * répond, sert les conversations — et c'est le premier utilisateur qui joint une
 * photo qui découvre la panne, en production, avec une erreur que personne
 * n'attendait. Même classe de défaut que le cache : une dépendance qui ne dit
 * rien tant qu'on ne s'en sert pas.
 *
 * `checkB2Connection` existait déjà dans le dépôt, écrite et JAMAIS APPELÉE.
 * C'est ce module qui lui donne enfin un usage.
 *
 * ⚠️ LE MODE LOCAL EST VÉRIFIÉ AUSSI, et pas seulement le nuage. Un disque plein
 * ou un dossier devenu non inscriptible — après un changement de droits, une
 * migration de machine — produit exactement le même silence.
 */

/** Ce que le point de santé rend. Volontairement sans aucun secret. */
export interface EtatStockage {
  /** « local » ou « b2 » — ce qui est RÉELLEMENT actif, pas ce qui est demandé. */
  fournisseur: "local" | "b2";
  /** Le stockage répond-il ? */
  actif: boolean;
  /**
   * Le bucket ouvert — accueils et sonneries.
   *
   * `null` quand il n'est pas configuré : ce n'est pas une panne, tout retombe
   * alors dans le bucket privé et le répondeur fonctionne, un peu plus
   * lentement. Le dire évite de chercher une optimisation absente.
   */
  ouvert: { actif: boolean; raison: string | null } | null;
  /**
   * Pourquoi il ne répond pas, en une phrase.
   *
   * ⚠️ JAMAIS LE MESSAGE BRUT DU FOURNISSEUR. Une erreur S3 porte le nom du
   * bucket, l'identifiant de clé et parfois l'hôte : ce point est ouvert sans
   * authentification, il ne doit rien divulguer de l'infrastructure.
   */
  raison: string | null;
}

/**
 * Traduit une panne en une raison dicible.
 *
 * On distingue les trois cas qui demandent des gestes différents : des
 * identifiants refusés, un bucket introuvable, ou le réseau. Tout le reste est
 * regroupé — une erreur qu'on ne sait pas nommer ne gagne rien à être recopiée.
 */
function raisonLisible(erreur: unknown): string {
  const e = erreur as { name?: string; $metadata?: { httpStatusCode?: number } };
  const code = e?.$metadata?.httpStatusCode;
  if (code === 401 || code === 403) return "identifiants refusés";
  if (code === 404) return "bucket introuvable";
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "délai dépassé";
  return "injoignable";
}

/**
 * Le stockage actif répond-il ?
 *
 * ⚠️ NE LÈVE JAMAIS. La panne EST la réponse : la faire remonter ferait tomber
 * le point de santé au moment précis où l'on vient l'interroger.
 */
/** Le bucket ouvert répond-il ? `null` quand il n'est pas configuré. */
async function etatOuvert(): Promise<EtatStockage["ouvert"]> {
  if (!publicConfigure()) return null;
  try {
    await Promise.race([
      checkB2PublicConnection(),
      new Promise((_, rejeter) =>
        setTimeout(
          () => rejeter(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
          4000,
        ),
      ),
    ]);
    return { actif: true, raison: null };
  } catch (err) {
    return { actif: false, raison: raisonLisible(err) };
  }
}

export async function etatStockage(): Promise<EtatStockage> {
  /*
   * ⚠️ « CONFIGURÉ » ET « ACTIF » NE SONT PAS LA MÊME CHOSE. `MEDIA_STORAGE_PROVIDER=b2`
   * avec une clé manquante retombe EN SILENCE sur le disque local — c'est le
   * comportement voulu du dépôt, et c'est exactement ce qu'il faut savoir :
   * on croit écrire dans le nuage, et tout s'empile sur le VPS.
   */
  const ouvert = await etatOuvert();

  if (env.media.provider === "b2" && !stockageNuage()) {
    return {
      fournisseur: "local",
      actif: false,
      raison: "B2 demandé mais mal configuré",
      ouvert,
    };
  }

  if (stockageNuage()) {
    try {
      /*
       * Un plafond de temps : sans lui, un Backblaze injoignable ferait attendre
       * le point de santé jusqu'au délai TCP du système — et une sonde de
       * surveillance conclurait que TOUT le serveur est tombé.
       */
      await Promise.race([
        checkB2Connection(),
        new Promise((_, rejeter) =>
          setTimeout(() => rejeter(Object.assign(new Error("timeout"), { name: "TimeoutError" })), 4000),
        ),
      ]);
      return { fournisseur: "b2", actif: true, raison: null, ouvert };
    } catch (err) {
      return { fournisseur: "b2", actif: false, raison: raisonLisible(err), ouvert };
    }
  }

  try {
    /*
     * ⚠️ ON VÉRIFIE LE DROIT D'ÉCRIRE, PAS SEULEMENT L'EXISTENCE. Un dossier qui
     * existe mais n'accepte plus l'écriture — droits changés, disque plein — se
     * comporte exactement comme un dossier absent au moment de l'envoi, et
     * `existsSync` n'y verrait que du feu.
     */
    await fs.mkdir(storageRoot(), { recursive: true });
    await fs.access(storageRoot(), fs.constants.W_OK);
    return { fournisseur: "local", actif: true, raison: null, ouvert };
  } catch {
    return {
      fournisseur: "local",
      actif: false,
      raison: "dossier inaccessible en écriture",
      ouvert,
    };
  }
}
