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
 * QUEL FOURNISSEUR POUR QUEL COURRIEL (décision du user, 03/10/2026).
 *
 *   - POSTMARK : ce qui ouvre un compte ou le rend — inscription, mot de passe
 *     oublié, création d'un compte agent ;
 *   - BIRD : tout le reste — changement d'adresse, double authentification,
 *     confirmation d'adresse.
 *
 * Les clés sont les motifs de `courriel-contenu.mjs`. Un motif absent d'ici va
 * chez Postmark : c'est l'ancien comportement, quand Postmark envoyait tout.
 */
export const VOIE_DU_MOTIF = {
  INSCRIPTION: "postmark",
  MOT_DE_PASSE: "postmark",
  CREATION_AGENT: "postmark",
  CHANGEMENT_ADRESSE: "bird",
  DOUBLE_AUTH: "bird",
  VALIDATION_CONTACT: "bird",
};

/** Délai de Bird : même raisonnement que celui de Postmark, juste en dessous. */
export const DELAI_BIRD_MS = 10_000;

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
 *   - `auto`     : le fournisseur DU MOTIF (`VOIE_DU_MOTIF`) dès que sa clé est
 *                  posée, sinon SMTP. C'est le réglage normal.
 *   - `postmark` : Postmark pour TOUT — le secours si Bird est indisponible.
 *   - `bird`     : Bird pour TOUT — le secours si Postmark est indisponible.
 *   - `smtp`     : l'ancien relais SMTP seul — c'est le RETOUR ARRIÈRE.
 *
 * ⚠️ EN `auto`, UNE CLÉ MANQUANTE RETOMBE SUR SMTP, JAMAIS SUR L'AUTRE
 * FOURNISSEUR. Le partage entre Postmark et Bird est une décision : le défaire
 * en silence parce qu'une clé n'est pas encore posée enverrait des courriels
 * par un canal qu'on n'a pas choisi, sans que personne ne le voie.
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
 * @param {{ provider?: string | null, motif?: string | null, jetonPostmark?: string | null, cleBird?: string | null, smtpConfigure: boolean }} reglages
 * @returns {{ fournisseur: "postmark" | "bird" | "smtp" | null, raison?: string, inconnu?: boolean }}
 */
export function choisirFournisseur({ provider, motif, jetonPostmark, cleBird, smtpConfigure }) {
  const demande = String(provider ?? "").trim().toLowerCase() || "auto";
  const aJeton = Boolean(jetonPostmark && jetonPostmark.trim());
  const aCleBird = Boolean(cleBird && cleBird.trim());

  if (demande === "postmark") {
    return aJeton
      ? { fournisseur: "postmark" }
      : { fournisseur: null, raison: "MAIL_PROVIDER=postmark mais POSTMARK_SERVER_TOKEN absent" };
  }
  if (demande === "bird") {
    return aCleBird
      ? { fournisseur: "bird" }
      : { fournisseur: null, raison: "MAIL_PROVIDER=bird mais BIRD_API_KEY absent" };
  }
  if (demande === "smtp") {
    return smtpConfigure
      ? { fournisseur: "smtp" }
      : { fournisseur: null, raison: "MAIL_PROVIDER=smtp mais SMTP_HOST/SMTP_USER/SMTP_PASS incomplets" };
  }

  const inconnu = demande !== "auto";
  const voie = VOIE_DU_MOTIF[motif] ?? "postmark";
  const aCle = voie === "bird" ? aCleBird : aJeton;
  if (aCle) return inconnu ? { fournisseur: voie, inconnu } : { fournisseur: voie };
  if (smtpConfigure) return inconnu ? { fournisseur: "smtp", inconnu } : { fournisseur: "smtp" };
  const cle = voie === "bird" ? "BIRD_API_KEY" : "POSTMARK_SERVER_TOKEN";
  return {
    fournisseur: null,
    raison: `aucun fournisseur configuré pour ce courriel (ni ${cle}, ni SMTP)`,
    ...(inconnu ? { inconnu } : {}),
  };
}

/**
 * L'hôte de l'API de Bird, DÉDUIT DE LA CLÉ.
 *
 * Une clé Bird porte sa région : `bk_eu1_…` ne vaut que sur
 * `eu1.platform.bird.com`. L'envoyer ailleurs rend « API key is not valid…
 * issued for a different region » — une erreur qui fait chercher une clé
 * fausse alors qu'elle est bonne. La déduire supprime la question ;
 * `BIRD_API_URL` reste là pour forcer un hôte si Bird en change.
 *
 * @param {string} cle @param {string | null | undefined} [surcharge]
 */
export function hoteBird(cle, surcharge) {
  const force = String(surcharge ?? "").trim().replace(/\/+$/, "");
  if (force) return force;
  const region = /^bk_([a-z]+[0-9]*)_/i.exec(String(cle ?? "").trim())?.[1]?.toLowerCase();
  return `https://${region ?? "eu1"}.platform.bird.com`;
}

/**
 * « Alanya Work <info@alanya.cloud> » → `{ name, email }`, la forme que Bird
 * attend. Une adresse nue garde un nom vide.
 *
 * @param {string} adresse
 */
export function decomposerAdresse(adresse) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(adresse ?? ""));
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: "", email: String(adresse ?? "").trim() };
}

/**
 * Envoie UN courriel par l'API e-mail de Bird (`POST /v1/email/messages`).
 *
 * Même contrat que `envoyerParPostmark` : ne lève jamais, rend
 * `{ remis, detail }`. `remis` n'est vrai que si Bird a ACCEPTÉ le message
 * (HTTP 202, statut `accepted`). En cas de succès, `detail` porte son
 * identifiant (`bird em_…`), celui qu'on cherche dans la console Bird.
 *
 * Refus notables : 401 `InvalidAPIKey` (clé fausse ou d'une autre région) ;
 * 422 `ValidationError` (expéditeur hors d'un domaine vérifié, champ invalide).
 *
 * ⚠️ `category: "transactional"` : un code n'est pas de la publicité. Bird
 * applique les désinscriptions marketing aux envois `marketing` — un
 * destinataire désinscrit des lettres d'information ne doit pas cesser de
 * recevoir ses codes de connexion.
 *
 * @param {{ to: string, subject: string, text: string, html: string, tag?: string }} message
 * @param {{ cle: string, expediteur: string, hote?: string | null, delaiMs?: number }} reglages
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ remis: boolean, detail?: string }>}
 */
export async function envoyerParBird(message, reglages, fetchImpl = fetch) {
  const { cle, expediteur, delaiMs = DELAI_BIRD_MS } = reglages;
  if (!cle) return { remis: false, detail: "Bird : clé absente" };

  const de = decomposerAdresse(expediteur);
  let reponse;
  try {
    reponse = await fetchImpl(`${hoteBird(cle, reglages.hote)}/v1/email/messages`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${cle}`,
      },
      body: JSON.stringify({
        from: de.name ? { email: de.email, name: de.name } : { email: de.email },
        to: [{ email: message.to }],
        subject: message.subject,
        html: message.html,
        text: message.text,
        category: "transactional",
        // Un code de sécurité n'a rien à mesurer : aucun lien réécrit vers un
        // domaine de suivi.
        track_clicks: false,
        ...(message.tag ? { tags: [{ name: "motif", value: message.tag }] } : {}),
      }),
      signal: AbortSignal.timeout(delaiMs),
    });
  } catch (err) {
    const cause = err instanceof Error ? `${err.name} ${err.message}` : String(err);
    return { remis: false, detail: borner(`Bird injoignable : ${cause}`) };
  }

  /** @type {any} */
  let corps = null;
  try {
    corps = await reponse.json();
  } catch {
    // Page HTML d'un intermédiaire : le statut HTTP suffira.
  }

  if (reponse.ok && corps && corps.id && corps.status !== "rejected") {
    return { remis: true, detail: borner(`bird ${corps.id}`) };
  }

  const erreur = corps && typeof corps.error === "object" ? corps.error : null;
  const nom = erreur && (erreur.name || erreur.code) ? ` (${[erreur.code, erreur.name].filter(Boolean).join(" ")})` : "";
  const precision = erreur && Array.isArray(erreur.details) && erreur.details[0]?.message ? ` — ${erreur.details[0].message}` : "";
  const texte = (erreur && erreur.message) || reponse.statusText || "réponse illisible";
  return { remis: false, detail: borner(`Bird ${reponse.status}${nom} : ${texte}${precision}`) };
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

  // --- Partage par motif ------------------------------------------------------
  const deux = { jetonPostmark: "p", cleBird: "b", smtpConfigure: true };
  verifie("inscription → Postmark", choisirFournisseur({ provider: "auto", motif: "INSCRIPTION", ...deux }).fournisseur, "postmark");
  verifie("mot de passe → Postmark", choisirFournisseur({ provider: "auto", motif: "MOT_DE_PASSE", ...deux }).fournisseur, "postmark");
  verifie("création d'agent → Postmark", choisirFournisseur({ provider: "auto", motif: "CREATION_AGENT", ...deux }).fournisseur, "postmark");
  verifie("changement d'adresse → Bird", choisirFournisseur({ provider: "auto", motif: "CHANGEMENT_ADRESSE", ...deux }).fournisseur, "bird");
  verifie("double authentification → Bird", choisirFournisseur({ provider: "auto", motif: "DOUBLE_AUTH", ...deux }).fournisseur, "bird");
  verifie("confirmation d'adresse → Bird", choisirFournisseur({ provider: "auto", motif: "VALIDATION_CONTACT", ...deux }).fournisseur, "bird");
  verifie(
    "Bird sans clé → SMTP, JAMAIS Postmark",
    choisirFournisseur({ provider: "auto", motif: "DOUBLE_AUTH", jetonPostmark: "p", cleBird: "", smtpConfigure: true }).fournisseur,
    "smtp",
  );
  verifie(
    "Bird sans clé ni SMTP → personne, avec la clé manquante nommée",
    choisirFournisseur({ provider: "auto", motif: "DOUBLE_AUTH", jetonPostmark: "p", cleBird: "", smtpConfigure: false }),
    { fournisseur: null, raison: "aucun fournisseur configuré pour ce courriel (ni BIRD_API_KEY, ni SMTP)" },
  );
  verifie("MAIL_PROVIDER=bird force Bird", choisirFournisseur({ provider: "bird", motif: "INSCRIPTION", ...deux }).fournisseur, "bird");
  verifie("MAIL_PROVIDER=postmark force Postmark", choisirFournisseur({ provider: "postmark", motif: "DOUBLE_AUTH", ...deux }).fournisseur, "postmark");
  verifie("MAIL_PROVIDER=smtp reste le retour arrière", choisirFournisseur({ provider: "smtp", motif: "DOUBLE_AUTH", ...deux }).fournisseur, "smtp");

  // --- Bird : hôte et adresse -------------------------------------------------
  verifie("hôte déduit de la clé eu1", hoteBird("bk_eu1_abc"), "https://eu1.platform.bird.com");
  verifie("hôte déduit de la clé us1", hoteBird("bk_us1_abc"), "https://us1.platform.bird.com");
  verifie("hôte forcé", hoteBird("bk_eu1_abc", "https://autre.bird.com/"), "https://autre.bird.com");
  verifie("adresse décomposée", decomposerAdresse("Alanya Work <info@alanya.cloud>"), { name: "Alanya Work", email: "info@alanya.cloud" });
  verifie("adresse entre guillemets", decomposerAdresse('"Alanya" <info@alanya.cloud>'), { name: "Alanya", email: "info@alanya.cloud" });
  verifie("adresse nue", decomposerAdresse("info@alanya.cloud"), { name: "", email: "info@alanya.cloud" });

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

  // --- Envoi par Bird, réseau simulé ----------------------------------------
  const reglagesBird = { cle: "bk_eu1_test", expediteur: "Alanya Work <info@alanya.cloud>" };
  const accepte = faux(202, { id: "em_01abc", status: "accepted", accepted_count: 1 });
  verifie("Bird accepté → remis, avec l'identifiant", await envoyerParBird(message, reglagesBird, accepte.impl), { remis: true, detail: "bird em_01abc" });
  verifie("Bird : bonne adresse, région de la clé", accepte.appel.url, "https://eu1.platform.bird.com/v1/email/messages");
  verifie("Bird : clé en Bearer", accepte.appel.init.headers.Authorization, "Bearer bk_eu1_test");
  const corpsBird = JSON.parse(accepte.appel.init.body);
  verifie("Bird : expéditeur décomposé", corpsBird.from, { email: "info@alanya.cloud", name: "Alanya Work" });
  verifie("Bird : destinataire", corpsBird.to, [{ email: "a@exemple.cm" }]);
  verifie("Bird : transactionnel, sans suivi des liens", [corpsBird.category, corpsBird.track_clicks], ["transactional", false]);
  verifie("Bird : étiquette du motif", corpsBird.tags, [{ name: "motif", value: "code-verification" }]);
  verifie("Bird : texte ET html", [corpsBird.text, corpsBird.html], ["Code 123456", "<b>123456</b>"]);
  verifie(
    "Bird : domaine non vérifié (422) → cause lisible",
    (await envoyerParBird(message, reglagesBird, faux(422, { error: { type: "validation_error", code: "E01001", name: "ValidationError", message: "Request has 1 validation error.", details: [{ param: "body", message: "sender domain is not verified" }] } }).impl)).detail,
    "Bird 422 (E01001 ValidationError) : Request has 1 validation error. — sender domain is not verified",
  );
  verifie(
    "Bird : clé refusée (401)",
    (await envoyerParBird(message, reglagesBird, faux(401, { error: { code: "E02072", name: "InvalidAPIKey", message: "This API key is not valid." } }).impl)).detail,
    "Bird 401 (E02072 InvalidAPIKey) : This API key is not valid.",
  );
  verifie(
    "Bird : délai dépassé → non remis, sans lever",
    (await envoyerParBird(message, reglagesBird, faux(0, null, { lever: coupure }).impl)).detail,
    "Bird injoignable : TimeoutError The operation was aborted due to timeout",
  );
  const sansCle = faux(202, { id: "x" });
  verifie("Bird sans clé → rien ne part", await envoyerParBird(message, { ...reglagesBird, cle: "" }, sansCle.impl), { remis: false, detail: "Bird : clé absente" });
  verifie("… et fetch n'est même pas appelé", sansCle.appel.url, "");
  verifie(
    "Bird : le code n'apparaît jamais dans le détail d'un échec",
    (await envoyerParBird(message, reglagesBird, faux(422, { error: { message: "Invalid" } }).impl)).detail.includes("123456"),
    false,
  );

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} ÉCHEC(S).`);
  process.exit(echecs === 0 ? 0 : 1);
}
