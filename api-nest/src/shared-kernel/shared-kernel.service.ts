import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Accès au NOYAU PARTAGÉ `src/lib/*.mjs` — le code de règles métier commun au
 * backend HTTP et au serveur WebSocket.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POURQUOI CE DÉTOUR (risque R2 du plan de migration)
 *
 * Ces fichiers sont en JavaScript brut, et non en TypeScript, parce qu'ils sont
 * importés à la fois par le backend (TS) et par `ws-server.mjs` (Node ESM pur,
 * jamais compilé). Ils sont la SEULE source de vérité de règles comme le nom
 * affiché d'un utilisateur : les dupliquer ici ferait diverger silencieusement
 * l'API et le temps réel.
 *
 * Deux contraintes se combinent :
 *
 *  1. Ce sont des modules ESM. Nest compile en CommonJS, et un module CJS ne
 *     peut pas `require()` de l'ESM. D'où l'`import()` dynamique, effectué UNE
 *     FOIS au démarrage : le résultat est mis en cache, donc les appels en
 *     cours de requête restent synchrones.
 *
 *  2. `ws-server.mjs` importe ces fichiers par CHEMIN EN DUR
 *     (`./src/lib/display-name.mjs`). Ils ne doivent donc ni être déplacés, ni
 *     être recopiés dans `api-nest/`, ni être transpilés — sinon le serveur
 *     WebSocket tombe, alors qu'il est hors périmètre de la migration.
 *
 * On les lit donc là où ils sont, à la racine du dépôt. Le chemin relatif est
 * le même en développement et après compilation : `api-nest/src/shared-kernel`
 * et `api-nest/dist/shared-kernel` sont à la même profondeur.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Le sous-ensemble d'un utilisateur dont `nomAffichage` a besoin. */
export interface UtilisateurAffichable {
  nom?: string | null;
  pseudo?: string | null;
  publicNumber?: string | null;
}

/** Le sous-ensemble d'un compte dont `estCompteCentre` a besoin. */
export interface CompteTypable {
  typeCompte?: unknown;
}

interface ModuleDisplayName {
  nomAffichage: (u: UtilisateurAffichable | null | undefined) => string | null;
}

interface ModuleIvr {
  estCompteCentre: (u: CompteTypable | null | undefined) => boolean;
}

/**
 * `import()` ESM VÉRITABLE, préservé de la compilation TypeScript.
 *
 * ⚠️ Sans ce détour, rien ne fonctionne. Avec `"module": "commonjs"`, TypeScript
 * réécrit tout `import()` littéral en `require()` — qui ne sait pas charger un
 * module ESM et échoue en `MODULE_NOT_FOUND` au démarrage. Construire la
 * fonction à l'exécution place l'expression hors de portée du compilateur, qui
 * la laisse intacte.
 *
 * Constaté en conditions réelles au premier démarrage de Nest (16/08/2026).
 */
const importEsm = new Function("chemin", "return import(chemin)") as (
  chemin: string,
) => Promise<unknown>;

@Injectable()
export class SharedKernelService implements OnModuleInit {
  private readonly logger = new Logger(SharedKernelService.name);

  private displayName!: ModuleDisplayName;
  private ivr!: ModuleIvr;

  async onModuleInit(): Promise<void> {
    this.displayName = await this.charger<ModuleDisplayName>("display-name.mjs");
    this.ivr = await this.charger<ModuleIvr>("ivr.mjs");
    this.logger.log("Noyau .mjs partagé chargé (display-name, ivr)");
  }

  /**
   * Charge un module du noyau partagé.
   *
   * `pathToFileURL` n'est pas cosmétique : sous Windows, `import()` d'un chemin
   * absolu façon `C:\...` échoue (ERR_UNSUPPORTED_ESM_URL_SCHEME). Il faut une
   * URL `file://`.
   */
  private async charger<T>(fichier: string): Promise<T> {
    const chemin = join(__dirname, "..", "..", "..", "src", "lib", fichier);
    return (await importEsm(pathToFileURL(chemin).href)) as T;
  }

  /**
   * Nom à afficher pour un utilisateur — MÊME règle que le serveur WebSocket.
   * Ne pas réimplémenter : c'est précisément ce que ce service évite.
   */
  nomAffichage(u: UtilisateurAffichable | null | undefined): string | null {
    return this.displayName.nomAffichage(u);
  }

  /** Ce compte est-il un centre d'appels ? MÊME règle que le WebSocket. */
  estCompteCentre(u: CompteTypable | null | undefined): boolean {
    return this.ivr.estCompteCentre(u);
  }
}
