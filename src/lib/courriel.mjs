/**
 * Courrier sortant : QUEL fournisseur envoie, et l'envoi par Postmark.
 *
 * POURQUOI POSTMARK : jusqu'ici les codes partaient d'une adresse Gmail
 * personnelle, relayée par `smtp.gmail.com`. Trois défauts, dont un fatal pour
 * une double authentification : Gmail plafonne à 500 destinataires par jour et
 * SUSPEND l'envoi 24 h au dépassement ; aucun SPF/DKIM/DMARC n'est possible pour
 * `gmail.com`, donc les codes finissent en indésirables ; et le mot de passe
 * d'application posé dans `.env` ouvre TOUTE la messagerie privée, pas
 * seulement l'envoi. Postmark envoie depuis `alanyavox.com`, signé DKIM, et son
 * jeton ne sait faire qu'une chose : envoyer.
 *
 * ⚠️ Ce fichier n'importe RIEN, volontairement : il s'exécute directement
 * (`node src/lib/courriel.mjs`) et porte ses propres cas de contrôle, comme
 * `telephone.mjs`. Le réseau y est INJECTÉ (`fetchImpl`) : les contrôles
 * tournent hors ligne, sans jeton, sans rien envoyer.
 *
 * ⚠️ Aucune fonction d'ici n'écrit dans les journaux : c'est `mailer.ts` qui le
 * fait, et il ne journalise que le destinataire, JAMAIS le code.
 */

/** Adresse de l'API d'envoi unitaire de Postmark. */
export const POSTMARK_URL = "https://api.postmarkapp.com/email";

/**
 * Au-delà, on abandonne. Un code de connexion qui arrive après une minute ne
 * sert plus : mieux vaut rendre la main à l'utilisateur, qui redemandera.
 * `fetch` n'a AUCUN délai par défaut — sans celui-ci, une API qui ne répond pas
 * suspendrait la requête d'inscription indéfiniment.
 */
export const DELAI_POSTMARK_MS = 10_000;

/** Longueur de `verification.livraison_detail` (VARCHAR 255). */
const DETAIL_MAX = 255;

/**
 * Décide qui envoie.
 *
 *   - `postmark` : Postmark seul.
 *   - `smtp`     : l'ancien relais SMTP seul — c'est le RETOUR ARRIÈRE.
 *   - `auto`     : Postmark dès que son jeton est posé, sinon SMTP.
 *
 * ⚠️ UNE VALEUR INCONNUE VAUT `auto`, ET NE BLOQUE RIEN. `MAIL_PROVIDER`
 * existait avant ce fichier sans qu'aucun code ne le lise (d'anciens `.env`
 * portent `smtp`, voire `firebase`). Refuser une valeur inconnue couperait
 * l'envoi au premier déploiement, sur un serveur dont on ne connaît pas le
 * fichier. `inconnu` le signale pour que l'appelant l'écrive dans les journaux.
 *
 * ⚠️ PAS DE BASCULE AUTOMATIQUE D'UN FOURNISSEUR À L'AUTRE EN CAS D'ÉCHEC.
 * Retomber sur Gmail quand Postmark refuse masquerait une configuration fausse
 * (domaine non vérifié, jeton révoqué) derrière des envois qui « marchent », et
 * garderait le mot de passe Gmail indispensable. Le repli se fait à la main, en
 * posant `MAIL_PROVIDER=smtp`.
 *
 * @param {{ provider?: string | null, jetonPostmark?: string | null, smtpConfigure: boolean }} reglages
 * @returns {{ fournisseur: "postmark" | "smtp" | null, raison?: string, inconnu?: boolean }}
 */
export function choisirFournisseur({ provider, jetonPostmark, smtpConfigure }) {
  const demande = String(provider ?? "").trim().toLowerCase() || "auto";
  const aJeton = Boolean(jetonPostmark && jetonPostmark.trim());

  if (demande === "postmark") {
    return aJeton
      ? { fournisseur: "postmark" }
      : { fournisseur: null, raison: "MAIL_PROVIDER=postmark mais POSTMARK_SERVER_TOKEN absent" };
  }
  if (demande === "smtp") {
    return smtpConfigure
      ? { fournisseur: "smtp" }
      : { fournisseur: null, raison: "MAIL_PROVIDER=smtp mais SMTP_HOST/SMTP_USER/SMTP_PASS incomplets" };
  }

  const inconnu = demande !== "auto";
  if (aJeton) return inconnu ? { fournisseur: "postmark", inconnu } : { fournisseur: "postmark" };
  if (smtpConfigure) return inconnu ? { fournisseur: "smtp", inconnu } : { fournisseur: "smtp" };
  return {
    fournisseur: null,
    raison: "aucun fournisseur configuré (ni POSTMARK_SERVER_TOKEN, ni SMTP)",
    ...(inconnu ? { inconnu } : {}),
  };
}

/**
 * Envoie UN courriel par l'API de Postmark.
 *
 * Ne lève jamais : rend `{ remis, detail }`, comme `sendOtpEmail`. `remis` n'est
 * vrai que si Postmark a ACCEPTÉ le message (HTTP 200 et `ErrorCode` 0) — pas
 * « la requête est partie ».
 *
 * En cas de succès, `detail` porte l'identifiant Postmark du message
 * (`postmark <MessageID>`), rangé dans `verification.livraison_detail` : c'est
 * lui qu'on cherche dans l'onglet Activity de Postmark quand quelqu'un dit
 * « je n'ai jamais reçu le code ».
 *
 * Refus notables (`ErrorCode`) : 10 jeton invalide ; 300 requête invalide
 * (adresse mal formée, expéditeur absent) ; 400 expéditeur non vérifié ;
 * 406 destinataire désactivé par Postmark après un rebond ou une plainte ;
 * 412 compte en attente d'approbation (n'envoie qu'au domaine de l'expéditeur).
 *
 * @param {{ to: string, subject: string, text: string, html: string, tag?: string }} message
 * @param {{ jeton: string, expediteur: string, flux?: string, delaiMs?: number }} reglages
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ remis: boolean, detail?: string }>}
 */
export async function envoyerParPostmark(message, reglages, fetchImpl = fetch) {
  const { jeton, expediteur, flux = "outbound", delaiMs = DELAI_POSTMARK_MS } = reglages;
  if (!jeton) return { remis: false, detail: "Postmark : jeton absent" };

  let reponse;
  try {
    reponse = await fetchImpl(POSTMARK_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": jeton,
      },
      body: JSON.stringify({
        From: expediteur,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        HtmlBody: message.html,
        MessageStream: flux,
        ...(message.tag ? { Tag: message.tag } : {}),
        // Un code de sécurité n'a rien à mesurer : pas de pixel d'ouverture,
        // et aucun lien réécrit vers un domaine de suivi.
        TrackOpens: false,
        TrackLinks: "None",
      }),
      signal: AbortSignal.timeout(delaiMs),
    });
  } catch (err) {
    // Réseau coupé, DNS, ou délai dépassé (`TimeoutError`).
    const cause = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    return { remis: false, detail: borner(`Postmark injoignable : ${cause}`) };
  }

  /** @type {{ ErrorCode?: number, Message?: string, MessageID?: string } | null} */
  let corps = null;
  try {
    corps = await reponse.json();
  } catch {
    // Une page HTML d'un intermédiaire (502, 503) : le statut HTTP suffira.
  }

  if (reponse.ok && corps && corps.ErrorCode === 0) {
    return { remis: true, detail: borner(`postmark ${corps.MessageID ?? "?"}`) };
  }

  const code = corps && typeof corps.ErrorCode === "number" ? ` (code ${corps.ErrorCode})` : "";
  const texte = (corps && corps.Message) || reponse.statusText || "réponse illisible";
  return { remis: false, detail: borner(`Postmark ${reponse.status}${code} : ${texte}`) };
}

/** @param {string} texte */
function borner(texte) {
  return texte.length > DETAIL_MAX ? texte.slice(0, DETAIL_MAX) : texte;
}

// ---------------------------------------------------------------------------
// Contrôles : `node src/lib/courriel.mjs`. Aucun réseau, aucun jeton réel.
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("courriel.mjs")) {
  let echecs = 0;
  /** @param {string} nom @param {unknown} obtenu @param {unknown} attendu */
  const verifie = (nom, obtenu, attendu) => {
    const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
    if (!ok) echecs++;
    console.log(`${ok ? "ok   " : "ÉCHEC"} ${nom}${ok ? "" : `\n      obtenu  ${JSON.stringify(obtenu)}\n      attendu ${JSON.stringify(attendu)}`}`);
  };

  // --- Choix du fournisseur -------------------------------------------------
  const smtp = { smtpConfigure: true };
  const rien = { smtpConfigure: false };
  verifie("auto + jeton → Postmark", choisirFournisseur({ provider: "auto", jetonPostmark: "x", ...smtp }).fournisseur, "postmark");
  verifie("variable absente = auto", choisirFournisseur({ provider: undefined, jetonPostmark: "x", ...rien }).fournisseur, "postmark");
  verifie("auto sans jeton → SMTP, comme avant", choisirFournisseur({ provider: "", jetonPostmark: "", ...smtp }).fournisseur, "smtp");
  verifie("jeton fait d'espaces = pas de jeton", choisirFournisseur({ provider: "auto", jetonPostmark: "   ", ...smtp }).fournisseur, "smtp");
  verifie("auto sans rien → personne", choisirFournisseur({ provider: "auto", jetonPostmark: null, ...rien }).fournisseur, null);
  verifie("postmark sans jeton → personne, pas de repli Gmail", choisirFournisseur({ provider: "postmark", jetonPostmark: "", ...smtp }).fournisseur, null);
  verifie("smtp l'emporte sur le jeton : c'est le retour arrière", choisirFournisseur({ provider: "smtp", jetonPostmark: "x", ...smtp }).fournisseur, "smtp");
  verifie("smtp demandé mais incomplet → personne", choisirFournisseur({ provider: "smtp", jetonPostmark: "x", ...rien }).fournisseur, null);
  verifie("casse et espaces ignorés", choisirFournisseur({ provider: " PostMark ", jetonPostmark: "x", ...rien }).fournisseur, "postmark");
  verifie(
    "valeur héritée inconnue : agit comme auto ET se signale",
    choisirFournisseur({ provider: "firebase", jetonPostmark: "", ...smtp }),
    { fournisseur: "smtp", inconnu: true },
  );

  // --- Envoi par Postmark, réseau simulé ------------------------------------
  /** Fabrique un faux `fetch` qui mémorise la requête et rend `reponse`. */
  const faux = (statut, corps, { lever } = {}) => {
    const appel = { url: "", init: /** @type {any} */ (null) };
    const impl = async (url, init) => {
      appel.url = url;
      appel.init = init;
      if (lever) throw lever;
      return new Response(typeof corps === "string" ? corps : JSON.stringify(corps), { status: statut });
    };
    return { appel, impl: /** @type {typeof fetch} */ (/** @type {unknown} */ (impl)) };
  };
  const message = { to: "a@exemple.cm", subject: "Code", text: "Code 123456", html: "<b>123456</b>", tag: "code-verification" };
  const reglages = { jeton: "jeton-test", expediteur: "Alanya <no-reply@alanyavox.com>" };

  const ok = faux(200, { To: "a@exemple.cm", SubmittedAt: "2026-09-11T10:00:00Z", MessageID: "b7bc2f4a", ErrorCode: 0, Message: "OK" });
  verifie("accepté → remis, avec l'identifiant Postmark", await envoyerParPostmark(message, reglages, ok.impl), { remis: true, detail: "postmark b7bc2f4a" });
  verifie("bonne adresse d'API", ok.appel.url, "https://api.postmarkapp.com/email");
  verifie("jeton dans l'en-tête dédié", ok.appel.init.headers["X-Postmark-Server-Token"], "jeton-test");
  const envoye = JSON.parse(ok.appel.init.body);
  verifie("expéditeur, destinataire et flux transactionnel", [envoye.From, envoye.To, envoye.MessageStream], ["Alanya <no-reply@alanyavox.com>", "a@exemple.cm", "outbound"]);
  verifie("aucun suivi d'ouverture ni de lien", [envoye.TrackOpens, envoye.TrackLinks], [false, "None"]);
  verifie("texte ET html transmis", [envoye.TextBody, envoye.HtmlBody], ["Code 123456", "<b>123456</b>"]);
  verifie("un délai est toujours posé", ok.appel.init.signal instanceof AbortSignal, true);

  verifie(
    "destinataire désactivé (406) → non remis, cause lisible",
    await envoyerParPostmark(message, reglages, faux(422, { ErrorCode: 406, Message: "You tried to send to recipient(s) that have been marked as inactive." }).impl),
    { remis: false, detail: "Postmark 422 (code 406) : You tried to send to recipient(s) that have been marked as inactive." },
  );
  verifie(
    "jeton refusé (401)",
    (await envoyerParPostmark(message, reglages, faux(401, { ErrorCode: 10, Message: "Bad or missing Server API token." }).impl)).detail,
    "Postmark 401 (code 10) : Bad or missing Server API token.",
  );
  verifie(
    "HTTP 200 mais ErrorCode non nul → NON remis",
    (await envoyerParPostmark(message, reglages, faux(200, { ErrorCode: 412, Message: "Account pending approval" }).impl)).remis,
    false,
  );
  verifie(
    "page HTML d'un intermédiaire → non remis, sans planter",
    (await envoyerParPostmark(message, reglages, faux(502, "<html>Bad Gateway</html>").impl)).detail.startsWith("Postmark 502"),
    true,
  );
  const coupure = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  verifie(
    "délai dépassé → non remis, sans lever",
    (await envoyerParPostmark(message, reglages, faux(0, null, { lever: coupure }).impl)).detail,
    "Postmark injoignable : TimeoutError The operation was aborted due to timeout",
  );
  const sansJeton = faux(200, { ErrorCode: 0 });
  verifie("sans jeton → rien ne part", await envoyerParPostmark(message, { ...reglages, jeton: "" }, sansJeton.impl), { remis: false, detail: "Postmark : jeton absent" });
  verifie("… et fetch n'est même pas appelé", sansJeton.appel.url, "");
  verifie(
    "détail borné à la colonne (255)",
    (await envoyerParPostmark(message, reglages, faux(422, { ErrorCode: 300, Message: "x".repeat(400) }).impl)).detail.length,
    255,
  );
  verifie(
    "le code n'apparaît jamais dans le détail d'un échec",
    (await envoyerParPostmark(message, reglages, faux(422, { ErrorCode: 300, Message: "Invalid email request" }).impl)).detail.includes("123456"),
    false,
  );

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} ÉCHEC(S).`);
  process.exit(echecs === 0 ? 0 : 1);
}
