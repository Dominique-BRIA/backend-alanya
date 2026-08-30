import type { Prisma } from "@prisma/client";

/**
 * L'ORDRE DES MÉDIAS D'UN MESSAGE.
 *
 * 🔴 SANS `orderBy`, LES PHOTOS ARRIVENT EN DÉSORDRE (constaté sur device le
 * 30/08/2026 : « les images sont envoyées en désordre »).
 *
 * Le client téléverse les fichiers UN PAR UN, dans l'ordre de sélection, et
 * envoie la liste d'identifiants dans ce même ordre
 * (`envoi_media_store.dart` : `mediaIdsObtenus.add(...)` après chaque
 * téléversement). L'ordre est donc juste au départ — il se perd à la LECTURE :
 * `include: { media: true }` ne demande aucun tri, et PostgreSQL rend alors les
 * lignes dans l'ordre qui l'arrange, qui n'a aucune raison d'être celui de leur
 * création.
 *
 * `createdAt` remet donc l'ordre d'envoi, et `id` départage deux médias créés
 * dans la même microseconde — non pour être « le bon » ordre dans ce cas (un
 * uuid est tiré au hasard), mais pour que la grille ne se réarrange pas d'un
 * rafraîchissement à l'autre. Un ordre stable et faux est déjà bien moins
 * déroutant qu'un ordre qui change à chaque lecture.
 *
 * ⚠️ LIMITE ASSUMÉE : l'ordre voulu n'est pas STOCKÉ. Le tenir vraiment
 * demanderait une colonne `position` sur `media`, remplie depuis le rang dans
 * `mediaIds` — donc une migration et deux écritures (WebSocket et REST). Tant
 * que les téléversements restent séquentiels, `createdAt` les distingue et
 * suffit ; le jour où ils partiront en parallèle, il faudra la colonne.
 *
 * ⚠️ Ce fichier a un JUMEAU dans `ws-server.mjs` (`MEDIA_ORDONNE`), parce que le
 * serveur WebSocket est en `.mjs` et n'importe pas ce module. Les deux doivent
 * rester identiques : c'est le WebSocket qui sert le temps réel et le REST qui
 * sert le rechargement, et deux ordres différents feraient sauter la grille
 * entre l'arrivée du message et son relecture.
 */
/*
 * ⚠️ TYPÉ EXPLICITEMENT, ET SURTOUT PAS `as const` : Prisma attend un tableau
 * MUTABLE (`MediaFileOrderByWithRelationInput[]`), et `as const` le rend
 * `readonly` — le build échoue alors sur `Type ... is readonly and cannot be
 * assigned to the mutable type`. L'annotation garde les littéraux `"asc"`
 * corrects sans figer le tableau.
 */
export const MEDIA_ORDONNE: {
  orderBy: Prisma.MediaFileOrderByWithRelationInput[];
} = {
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
};
