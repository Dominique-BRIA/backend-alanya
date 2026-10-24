import { type StatusType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { trouverCompteOfficiel } from "./compte-officiel";
import { mediaDeConsole } from "./medias";
import { ErreurAdmin } from "./reponses";
import { lireReglage, ecrireReglage } from "./outils";
import { languesManquantes, nettoyerTraductions, texteDans, type Traductions } from "./langues-contenu";
import { type SessionAdmin } from "./session";

/**
 * LE STATUT DE BIENVENUE (24/10/2026), à l'identique d'Alanya2026
 * (`welcomeService.js` : `getWelcomeStatusConfig`, `deliverWelcomeStatus`).
 *
 * Un réglage GLOBAL et non versionné — l'interrupteur et les éléments
 * s'appliquent dès l'enregistrement, sans « Publier », contrairement au
 * message. À la fin de son inscription, chaque compte reçoit un statut de 24 h
 * par élément, publié par le compte officiel, dans la langue de son
 * application (repli anglais, puis français).
 *
 * Indépendant du message : les statuts partent même sans message publié, et
 * une erreur ici ne fait jamais échouer l'inscription.
 */

const CLE = "bienvenue.statut";
const ELEMENTS_MAX = 10;
/// Notre colonne `statut.text` est un VARCHAR(700).
const TEXTE_MAX = 700;
const DUREE_MS = 24 * 3600 * 1000;
/// L'indigo de marque, quand un statut texte n'a pas de couleur (le leur).
const COULEUR_DEFAUT = "#3F51B5";

/** 0 texte · 1 image · 2 vidéo, comme dans la console. */
type Element = {
  id: number;
  sortOrder: number;
  type: 0 | 1 | 2;
  translations: Traductions;
  mediaUrl: string;
  backgroundColor: string;
};

type Config = { enabled: boolean; blocks: Element[]; updatedAt: string | null; updatedBy: string | null };

const VIDE: Config = { enabled: false, blocks: [], updatedAt: null, updatedBy: null };

/** La configuration, dans la forme qu'attend la console (`WelcomeStatusConfig`). */
export async function lireStatutBienvenue() {
  const { valeur } = await lireReglage(CLE, VIDE);
  const c = { ...VIDE, ...(valeur as Partial<Config>) };
  return { ...c, blocks: [...c.blocks].sort((a, b) => a.sortOrder - b.sortOrder), supportsMultiple: true };
}

/** `#RRGGBB`, ou vide (couleur par défaut à la livraison). */
function couleur(brute: unknown): string {
  const c = typeof brute === "string" ? brute.trim() : "";
  if (!c) return "";
  if (!/^#[0-9a-f]{6}$/i.test(c)) throw new ErreurAdmin(400, "Couleur attendue au format #RRGGBB", "INVALID_COLOR");
  return c.toUpperCase();
}

/**
 * Enregistre interrupteur et éléments (`PUT /api/admin/welcome/status`). Prend
 * effet immédiatement, pour les inscriptions suivantes.
 */
export async function ecrireStatutBienvenue(brut: unknown, session: SessionAdmin) {
  const corps = (brut ?? {}) as { enabled?: unknown; blocks?: unknown };
  const actuel = await lireStatutBienvenue();
  const enabled = typeof corps.enabled === "boolean" ? corps.enabled : actuel.enabled;
  const bruts = Array.isArray(corps.blocks) ? corps.blocks : actuel.blocks;
  if (bruts.length > ELEMENTS_MAX) throw new ErreurAdmin(400, `${ELEMENTS_MAX} éléments au plus`, "TOO_MANY_BLOCKS");

  let prochainId = Math.max(0, ...actuel.blocks.map((b) => b.id)) + 1;
  const elements: Element[] = [];
  for (const [i, x] of (bruts as Record<string, unknown>[]).entries()) {
    const type = Number(x?.type ?? 0);
    if (![0, 1, 2].includes(type)) throw new ErreurAdmin(400, `Élément ${i + 1} : type 0, 1 ou 2`, "INVALID_TYPE");
    const translations = nettoyerTraductions(x?.translations, TEXTE_MAX);
    const mediaUrl = typeof x?.mediaUrl === "string" ? x.mediaUrl.trim() : "";
    if (type === 0 && Object.keys(translations).length === 0) continue; // élément vide : ignoré
    if (type !== 0 && !mediaUrl) {
      throw new ErreurAdmin(400, `Élément ${i + 1} : un statut ${type === 1 ? "image" : "vidéo"} exige un média`, "MEDIA_REQUIRED");
    }
    if (type !== 0 && !(await mediaDeConsole(mediaUrl))) {
      throw new ErreurAdmin(400, `Élément ${i + 1} : le média doit être envoyé depuis la console`, "MEDIA_NOT_FOUND");
    }
    // Un statut actif est vu par tous les nouveaux inscrits : la règle des
    // langues requises vaut dès l'enregistrement, là où il y a du texte.
    if (enabled && Object.keys(translations).length > 0 && languesManquantes(translations).length > 0) {
      throw new ErreurAdmin(400, `Traduction manquante — élément ${i + 1}`, "TRANSLATION_MISSING");
    }
    const idBrut = Number(x?.id);
    const id = Number.isInteger(idBrut) && actuel.blocks.some((b) => b.id === idBrut) ? idBrut : prochainId++;
    elements.push({
      id,
      sortOrder: elements.length,
      type: type as 0 | 1 | 2,
      translations,
      mediaUrl: type === 0 ? "" : mediaUrl,
      backgroundColor: type === 0 ? couleur(x?.backgroundColor) : "",
    });
  }

  const config: Config = { enabled, blocks: elements, updatedAt: new Date().toISOString(), updatedBy: session.nom };
  await ecrireReglage(CLE, config, session);
  return lireStatutBienvenue();
}

const TYPES: Record<0 | 1 | 2, StatusType> = { 0: "TEXT", 1: "IMAGE", 2: "VIDEO" };

/**
 * Publie, depuis le compte officiel, les statuts de bienvenue d'un compte —
 * un par élément qu'il n'a pas encore reçu. Ne lève jamais.
 */
export async function livrerStatutBienvenue(userId: string): Promise<string[]> {
  try {
    const config = await lireStatutBienvenue();
    if (!config.enabled) return [];
    const elements = config.blocks.filter((b) => (b.type === 0 ? Object.keys(b.translations).length > 0 : !!b.mediaUrl));
    if (!elements.length) return [];
    const officiel = await trouverCompteOfficiel();
    if (!officiel || officiel.id === userId) return [];
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { langue: true, isDelete: true, exclus: true } });
    if (!u || u.isDelete || u.exclus === 1) return [];

    const ids: string[] = [];
    for (const e of elements) {
      const deja = await prisma.gestionStatutBienvenueLivraison.findUnique({
        where: { userId_elementId: { userId, elementId: e.id } },
      });
      if (deja) continue;
      const maintenant = new Date();
      const statut = await prisma.status.create({
        data: {
          userId: officiel.id,
          type: TYPES[e.type],
          text: texteDans(e.translations, u.langue),
          mediaUrl: e.type === 0 ? null : e.mediaUrl,
          bgColor: e.type === 0 ? e.backgroundColor || COULEUR_DEFAUT : null,
          createdAt: maintenant,
          expiresAt: new Date(maintenant.getTime() + DUREE_MS),
        },
      });
      try {
        await prisma.gestionStatutBienvenueLivraison.create({ data: { userId, elementId: e.id, statutId: statut.id } });
        ids.push(statut.id);
      } catch {
        // Une livraison simultanée l'a déjà faite : ce statut-ci est de trop.
        await prisma.status.delete({ where: { id: statut.id } }).catch(() => {});
      }
    }
    return ids;
  } catch (e) {
    console.error(`[statut de bienvenue] ${userId} :`, e);
    return [];
  }
}

/** Les statuts de bienvenue livrés à ce lecteur, non expirés. */
export async function statutsLivresA(userId: string): Promise<string[]> {
  const lignes = await prisma.gestionStatutBienvenueLivraison.findMany({ where: { userId }, select: { statutId: true } });
  return lignes.map((l) => l.statutId);
}

/** Ce statut a-t-il été livré à ce lecteur ? (clé de visibilité) */
export async function statutLivreA(userId: string, statutId: string): Promise<boolean> {
  return (await prisma.gestionStatutBienvenueLivraison.count({ where: { userId, statutId } })) > 0;
}
