/**
 * LE JETON DE REFUS D'UN APPEL (07/11/2026).
 *
 * 🐛 CE QU'IL CORRIGE. Application tuée, le téléphone sonne par le push seul,
 * et c'est le code natif Android qui envoie le refus — avec le dernier jeton
 * d'accès que Flutter lui a laissé. Ce jeton vit 15 minutes. Application fermée
 * depuis plus longtemps, le refus recevait un 401 et restait en file : chez
 * l'appelant, ça sonnait jusqu'au bout.
 *
 * Le natif ne peut pas renouveler la session lui-même : notre serveur remplace
 * le jeton de renouvellement à chaque usage, et le consommer hors de Flutter
 * déconnecterait l'application.
 *
 * LA RÉPONSE : le push d'appel porte son propre droit de refuser. Un jeton qui
 * ne permet qu'une chose — refuser CET appel, pour CE destinataire — et qui
 * meurt avec la sonnerie.
 *
 * 🔴 IL NE DOIT JAMAIS VALOIR JETON D'ACCÈS. D'où un secret DÉRIVÉ, et pas le
 * secret d'accès lui-même : aucune vérification existante (`requireUser`, la
 * connexion WebSocket) ne peut l'accepter, même si l'une d'elles oubliait de
 * contrôler le champ `scope`. Il traverse FCM et dort dans les préférences du
 * téléphone : il doit valoir le moins possible.
 *
 * En `.mjs` : signé par `push.mjs` (processus WebSocket), vérifié par la route
 * Next `POST /api/calls/:id/reject`.
 */
import jwt from "jsonwebtoken";

const PORTEE = "refus_appel";

/// Plus long que la sonnerie (60 s côté téléphone, 90 s côté serveur), avec
/// la marge d'un push livré en retard.
const DUREE = "3m";

function secret() {
  const base = process.env.JWT_ACCESS_SECRET;
  return base ? `${base}:${PORTEE}` : null;
}

/** Le jeton qui permet à [userId] de refuser [callId]. Vide si le secret manque. */
export function signerJetonRefus(userId, callId) {
  const s = secret();
  if (!s || !userId || !callId) return "";
  return jwt.sign({ sub: userId, scope: PORTEE, cid: callId }, s, { expiresIn: DUREE });
}

/**
 * Le compte autorisé à refuser [callId] par ce jeton, ou `null`.
 * Ne lève jamais : un jeton faux, expiré ou d'un autre appel rend `null`.
 */
export function verifierJetonRefus(jeton, callId) {
  const s = secret();
  if (!s || !jeton || !callId) return null;
  try {
    const p = jwt.verify(jeton, s);
    if (p?.scope !== PORTEE || p?.cid !== callId || typeof p?.sub !== "string") return null;
    return p.sub;
  } catch {
    return null;
  }
}
