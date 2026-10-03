/**
 * LE CONTENU DES COURRIELS D'ALANYA WORK — un texte par MOTIF, dans les neuf
 * langues de l'application.
 *
 * 🔴 TOUT EST ICI, RIEN CHEZ LES FOURNISSEURS (décision du user, 03/10/2026).
 * Postmark et Bird ne reçoivent que le courriel déjà composé. Deux raisons :
 *   - le serveur Postmark « Alanya » sert AUSSI Alanya grand public, dont les
 *     courriels ont une autre forme : des modèles stockés là-bas partageraient
 *     un même espace de noms, et l'un pourrait écraser l'autre ;
 *   - changer de fournisseur ne demande ainsi rien de plus : le même texte part
 *     par Postmark, par Bird ou par le relais SMTP de secours.
 *
 * 🐛 CE QUE CE MODULE REMPLACE : un seul texte, en français, pour tout —
 * « Bienvenue sur Alanya ! Votre code de confirmation » partait aussi pour un
 * mot de passe oublié ou une double authentification.
 *
 * ⚠️ AUCUN IMPORT, comme `courriel.mjs` : il s'exécute directement
 * (`node src/lib/courriel-contenu.mjs`) et porte ses propres contrôles.
 */

/** Pourquoi un code part. Chaque motif a son texte et son fournisseur. */
export const MOTIF = {
  /** Création de compte (inscription). */
  INSCRIPTION: "INSCRIPTION",
  /** Mot de passe oublié. */
  MOT_DE_PASSE: "MOT_DE_PASSE",
  /** Création d'un compte agent, par la plateforme de l'équipe (API v1). */
  CREATION_AGENT: "CREATION_AGENT",
  /** Nouvelle adresse e-mail, saisie dans les réglages. */
  CHANGEMENT_ADRESSE: "CHANGEMENT_ADRESSE",
  /** Second facteur de connexion, par la plateforme de l'équipe (API v1). */
  DOUBLE_AUTH: "DOUBLE_AUTH",
  /** Confirmation d'une adresse, par la plateforme de l'équipe (API v1). */
  VALIDATION_CONTACT: "VALIDATION_CONTACT",
};

/** Les langues de l'application, dans l'ordre des catalogues. */
export const LANGUES = ["fr", "en", "es", "de", "pt", "ru", "zh", "sv", "no"];

/**
 * La langue du courriel, à partir de ce que le client a déclaré.
 *
 * Accepte un code nu (`"de"`) comme un en-tête `Accept-Language` complet
 * (`"fr-FR,fr;q=0.9,en;q=0.8"`), trié par préférence. Le web et le mobile y
 * posent la langue CHOISIE DANS L'APPLICATION ; un client plus ancien laisse
 * passer celle du navigateur, ce qui reste un bon second choix.
 *
 * ⚠️ `nb` et `nn` (bokmål, nynorsk) valent `no` : c'est ainsi qu'un navigateur
 * norvégien s'annonce, et l'application, elle, dit `no`.
 *
 * @param {string | null | undefined} entete
 * @returns {string}
 */
export function langueDepuis(entete) {
  const brut = String(entete ?? "").trim();
  if (!brut) return "fr";
  const choix = brut
    .split(",")
    .map((morceau, rang) => {
      const [etiquette, ...params] = morceau.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const poids = q ? Number(q.slice(2)) : 1;
      return { code: etiquette.trim().toLowerCase().split("-")[0], poids: Number.isFinite(poids) ? poids : 0, rang };
    })
    .filter((c) => c.code && c.poids > 0)
    .sort((a, b) => b.poids - a.poids || a.rang - b.rang);
  for (const { code } of choix) {
    const normal = code === "nb" || code === "nn" ? "no" : code;
    if (LANGUES.includes(normal)) return normal;
  }
  return "fr";
}

/**
 * Les phrases communes à tous les motifs, puis celles de chaque motif.
 * `{n}` est remplacé par la durée de validité, en minutes.
 */
const COMMUN = {
  fr: {
    expire: "Ce code expire dans {n} minutes.",
    secret: "Ne le communiquez à personne : l'équipe Alanya ne vous le demandera jamais.",
    ignorer: "Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.",
    pied: "E-mail automatique envoyé par Alanya Work. Merci de ne pas y répondre.",
  },
  en: {
    expire: "This code expires in {n} minutes.",
    secret: "Don't share it with anyone — the Alanya team will never ask you for it.",
    ignorer: "If you didn't request this, you can safely ignore this email.",
    pied: "Automated email from Alanya Work. Please do not reply.",
  },
  es: {
    expire: "Este código caduca en {n} minutos.",
    secret: "No lo comparta con nadie: el equipo de Alanya nunca se lo pedirá.",
    ignorer: "Si no ha realizado esta solicitud, simplemente ignore este correo.",
    pied: "Correo automático enviado por Alanya Work. Por favor, no responda.",
  },
  de: {
    expire: "Dieser Code läuft in {n} Minuten ab.",
    secret: "Geben Sie ihn an niemanden weiter – das Alanya-Team wird Sie nie danach fragen.",
    ignorer: "Falls Sie dies nicht angefordert haben, können Sie diese E-Mail einfach ignorieren.",
    pied: "Automatische E-Mail von Alanya Work. Bitte nicht antworten.",
  },
  pt: {
    expire: "Este código expira em {n} minutos.",
    secret: "Não o compartilhe com ninguém: a equipe Alanya nunca vai pedi-lo.",
    ignorer: "Se você não fez esta solicitação, basta ignorar este e-mail.",
    pied: "E-mail automático enviado pelo Alanya Work. Por favor, não responda.",
  },
  ru: {
    expire: "Срок действия кода истекает через {n} мин.",
    secret: "Никому его не сообщайте: команда Alanya никогда не попросит его у вас.",
    ignorer: "Если вы не отправляли этот запрос, просто проигнорируйте это письмо.",
    pied: "Автоматическое письмо от Alanya Work. Пожалуйста, не отвечайте на него.",
  },
  zh: {
    expire: "此验证码将在 {n} 分钟后失效。",
    secret: "请勿告诉任何人：Alanya 团队绝不会向你索要验证码。",
    ignorer: "如果这不是你本人的操作，请忽略此邮件。",
    pied: "此邮件由 Alanya Work 自动发送，请勿回复。",
  },
  sv: {
    expire: "Koden går ut om {n} minuter.",
    secret: "Dela den inte med någon – Alanya-teamet kommer aldrig att be dig om den.",
    ignorer: "Om du inte har gjort den här begäran kan du bortse från det här mejlet.",
    pied: "Automatiskt mejl från Alanya Work. Svara inte på det.",
  },
  no: {
    expire: "Koden utløper om {n} minutter.",
    secret: "Ikke del den med noen – Alanya-teamet vil aldri be deg om den.",
    ignorer: "Hvis du ikke har bedt om dette, kan du se bort fra denne e-posten.",
    pied: "Automatisk e-post fra Alanya Work. Ikke svar på den.",
  },
};

/** Objet, titre et phrase d'introduction de chaque motif. */
const PAR_MOTIF = {
  INSCRIPTION: {
    fr: ["Votre code de création de compte Alanya Work", "Bienvenue sur Alanya Work", "Voici votre code pour confirmer votre adresse e-mail et créer votre compte :"],
    en: ["Your Alanya Work sign-up code", "Welcome to Alanya Work", "Here is your code to confirm your email address and create your account:"],
    es: ["Su código de registro de Alanya Work", "Bienvenido a Alanya Work", "Este es su código para confirmar su dirección de correo y crear su cuenta:"],
    de: ["Ihr Registrierungscode für Alanya Work", "Willkommen bei Alanya Work", "Hier ist Ihr Code, um Ihre E-Mail-Adresse zu bestätigen und Ihr Konto zu erstellen:"],
    pt: ["Seu código de cadastro no Alanya Work", "Bem-vindo ao Alanya Work", "Aqui está o seu código para confirmar seu endereço de e-mail e criar sua conta:"],
    ru: ["Код для регистрации в Alanya Work", "Добро пожаловать в Alanya Work", "Вот ваш код для подтверждения адреса электронной почты и создания аккаунта:"],
    zh: ["你的 Alanya Work 注册验证码", "欢迎使用 Alanya Work", "这是你的验证码，用于确认邮箱地址并创建账号："],
    sv: ["Din registreringskod för Alanya Work", "Välkommen till Alanya Work", "Här är din kod för att bekräfta din e-postadress och skapa ditt konto:"],
    no: ["Registreringskoden din for Alanya Work", "Velkommen til Alanya Work", "Her er koden din for å bekrefte e-postadressen og opprette kontoen:"],
  },
  MOT_DE_PASSE: {
    fr: ["Réinitialisation de votre mot de passe Alanya Work", "Réinitialisation du mot de passe", "Vous avez demandé à réinitialiser votre mot de passe. Voici votre code :"],
    en: ["Reset your Alanya Work password", "Password reset", "You asked to reset your password. Here is your code:"],
    es: ["Restablecimiento de su contraseña de Alanya Work", "Restablecer la contraseña", "Ha solicitado restablecer su contraseña. Este es su código:"],
    de: ["Zurücksetzen Ihres Alanya-Work-Passworts", "Passwort zurücksetzen", "Sie haben das Zurücksetzen Ihres Passworts angefordert. Hier ist Ihr Code:"],
    pt: ["Redefinição da sua senha do Alanya Work", "Redefinição de senha", "Você pediu para redefinir sua senha. Aqui está o seu código:"],
    ru: ["Сброс пароля Alanya Work", "Сброс пароля", "Вы запросили сброс пароля. Вот ваш код:"],
    zh: ["重置你的 Alanya Work 密码", "重置密码", "你申请了重置密码。这是你的验证码："],
    sv: ["Återställ ditt lösenord för Alanya Work", "Återställning av lösenord", "Du har bett om att återställa ditt lösenord. Här är din kod:"],
    no: ["Tilbakestill passordet ditt for Alanya Work", "Tilbakestilling av passord", "Du har bedt om å tilbakestille passordet ditt. Her er koden din:"],
  },
  CREATION_AGENT: {
    fr: ["Code de création de compte agent — Alanya Work", "Création d'un compte agent", "Voici le code pour valider la création du compte agent :"],
    en: ["Agent account creation code — Alanya Work", "Agent account creation", "Here is the code to approve the creation of the agent account:"],
    es: ["Código de creación de cuenta de agente — Alanya Work", "Creación de una cuenta de agente", "Este es el código para validar la creación de la cuenta de agente:"],
    de: ["Code zur Erstellung eines Agentenkontos – Alanya Work", "Erstellung eines Agentenkontos", "Hier ist der Code, um die Erstellung des Agentenkontos zu bestätigen:"],
    pt: ["Código de criação de conta de agente — Alanya Work", "Criação de uma conta de agente", "Aqui está o código para validar a criação da conta de agente:"],
    ru: ["Код для создания аккаунта агента — Alanya Work", "Создание аккаунта агента", "Вот код для подтверждения создания аккаунта агента:"],
    zh: ["坐席账号创建验证码 — Alanya Work", "创建坐席账号", "这是用于确认创建坐席账号的验证码："],
    sv: ["Kod för att skapa ett agentkonto – Alanya Work", "Skapa ett agentkonto", "Här är koden för att godkänna att agentkontot skapas:"],
    no: ["Kode for å opprette en agentkonto – Alanya Work", "Opprette en agentkonto", "Her er koden for å godkjenne opprettelsen av agentkontoen:"],
  },
  CHANGEMENT_ADRESSE: {
    fr: ["Confirmez votre nouvelle adresse e-mail — Alanya Work", "Nouvelle adresse e-mail", "Pour associer cette adresse à votre compte Alanya Work, saisissez ce code :"],
    en: ["Confirm your new email address — Alanya Work", "New email address", "To link this address to your Alanya Work account, enter this code:"],
    es: ["Confirme su nueva dirección de correo — Alanya Work", "Nueva dirección de correo", "Para asociar esta dirección a su cuenta de Alanya Work, introduzca este código:"],
    de: ["Bestätigen Sie Ihre neue E-Mail-Adresse – Alanya Work", "Neue E-Mail-Adresse", "Um diese Adresse mit Ihrem Alanya-Work-Konto zu verknüpfen, geben Sie diesen Code ein:"],
    pt: ["Confirme seu novo endereço de e-mail — Alanya Work", "Novo endereço de e-mail", "Para vincular este endereço à sua conta do Alanya Work, digite este código:"],
    ru: ["Подтвердите новый адрес электронной почты — Alanya Work", "Новый адрес электронной почты", "Чтобы привязать этот адрес к аккаунту Alanya Work, введите этот код:"],
    zh: ["确认你的新邮箱地址 — Alanya Work", "新邮箱地址", "要将此地址绑定到你的 Alanya Work 账号，请输入以下验证码："],
    sv: ["Bekräfta din nya e-postadress – Alanya Work", "Ny e-postadress", "Ange den här koden för att koppla adressen till ditt Alanya Work-konto:"],
    no: ["Bekreft den nye e-postadressen din – Alanya Work", "Ny e-postadresse", "Skriv inn denne koden for å knytte adressen til Alanya Work-kontoen din:"],
  },
  DOUBLE_AUTH: {
    fr: ["Votre code de connexion Alanya Work", "Code de connexion", "Voici votre code pour terminer votre connexion :"],
    en: ["Your Alanya Work sign-in code", "Sign-in code", "Here is your code to finish signing in:"],
    es: ["Su código de inicio de sesión de Alanya Work", "Código de inicio de sesión", "Este es su código para completar el inicio de sesión:"],
    de: ["Ihr Anmeldecode für Alanya Work", "Anmeldecode", "Hier ist Ihr Code, um die Anmeldung abzuschließen:"],
    pt: ["Seu código de acesso do Alanya Work", "Código de acesso", "Aqui está o seu código para concluir o acesso:"],
    ru: ["Код для входа в Alanya Work", "Код для входа", "Вот ваш код для завершения входа:"],
    zh: ["你的 Alanya Work 登录验证码", "登录验证码", "这是你完成登录所需的验证码："],
    sv: ["Din inloggningskod för Alanya Work", "Inloggningskod", "Här är din kod för att slutföra inloggningen:"],
    no: ["Påloggingskoden din for Alanya Work", "Påloggingskode", "Her er koden din for å fullføre påloggingen:"],
  },
  VALIDATION_CONTACT: {
    fr: ["Confirmez votre adresse e-mail — Alanya Work", "Confirmation d'adresse", "Voici votre code pour confirmer cette adresse e-mail :"],
    en: ["Confirm your email address — Alanya Work", "Address confirmation", "Here is your code to confirm this email address:"],
    es: ["Confirme su dirección de correo — Alanya Work", "Confirmación de dirección", "Este es su código para confirmar esta dirección de correo:"],
    de: ["Bestätigen Sie Ihre E-Mail-Adresse – Alanya Work", "Adressbestätigung", "Hier ist Ihr Code, um diese E-Mail-Adresse zu bestätigen:"],
    pt: ["Confirme seu endereço de e-mail — Alanya Work", "Confirmação de endereço", "Aqui está o seu código para confirmar este endereço de e-mail:"],
    ru: ["Подтвердите адрес электронной почты — Alanya Work", "Подтверждение адреса", "Вот ваш код для подтверждения этого адреса электронной почты:"],
    zh: ["确认你的邮箱地址 — Alanya Work", "地址确认", "这是用于确认此邮箱地址的验证码："],
    sv: ["Bekräfta din e-postadress – Alanya Work", "Bekräftelse av adress", "Här är din kod för att bekräfta den här e-postadressen:"],
    no: ["Bekreft e-postadressen din – Alanya Work", "Bekreftelse av adresse", "Her er koden din for å bekrefte denne e-postadressen:"],
  },
};

/** L'étiquette du motif chez le fournisseur : on la cherche dans son historique. */
export function etiquetteDuMotif(motif) {
  const connu = Object.prototype.hasOwnProperty.call(PAR_MOTIF, motif) ? motif : MOTIF.INSCRIPTION;
  return `work-${connu.toLowerCase().replace(/_/g, "-")}`;
}

/** @param {string} texte */
function echapper(texte) {
  return String(texte)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Compose le courriel d'un code : objet, texte brut et HTML.
 *
 * ⚠️ LE HTML EST FAIT DE TABLEAUX ET DE STYLES EN LIGNE, et c'est voulu : les
 * messageries (Gmail, Outlook) ignorent les feuilles de style et la mise en
 * page moderne. Les couleurs sont celles de l'application — crème, encre,
 * terracotta.
 *
 * ⚠️ LE CODE N'EST PAS DANS L'OBJET NI DANS L'EN-TÊTE DE PRÉVISUALISATION : il
 * s'afficherait sur un écran verrouillé, en notification, sans ouvrir le
 * courriel — c'est ce qu'un second facteur doit éviter.
 *
 * @param {{ motif?: string, code: string, dureeMinutes: number, langue?: string | null }} params
 * @returns {{ subject: string, text: string, html: string, langue: string }}
 */
export function contenuCode({ motif, code, dureeMinutes, langue }) {
  const l = langueDepuis(langue);
  const textes = PAR_MOTIF[motif] ?? PAR_MOTIF.INSCRIPTION;
  const [objet, titre, intro] = textes[l];
  const c = COMMUN[l];
  const expire = c.expire.replace("{n}", String(Math.max(1, Math.round(dureeMinutes))));

  const text = [titre, "", intro, "", `    ${code}`, "", expire, c.secret, "", c.ignorer, "", "—", c.pied].join("\n");

  const police = "Arial, Helvetica, sans-serif";
  const html = `<!doctype html>
<html lang="${l}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${echapper(objet)}</title></head>
<body style="margin:0;padding:0;background:#f5efe6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${echapper(titre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5efe6;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;background:#ffffff;border:1px solid #eadbc8;border-radius:16px;">
<tr><td style="padding:28px 28px 6px;font-family:${police};font-size:20px;font-weight:bold;color:#2b1b12;">Alanya <span style="color:#c04d29;">Work</span></td></tr>
<tr><td style="padding:10px 28px 0;font-family:${police};">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#2b1b12;">${echapper(titre)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:#5c4433;">${echapper(intro)}</p>
</td></tr>
<tr><td style="padding:0 28px;">
<div style="font-family:'Courier New',Courier,monospace;font-size:34px;font-weight:bold;letter-spacing:8px;color:#8a4b2b;background:#fdfaf4;border:2px solid #e0b59a;border-radius:12px;padding:16px 8px;text-align:center;">${echapper(code)}</div>
</td></tr>
<tr><td style="padding:18px 28px 0;font-family:${police};font-size:14px;line-height:1.5;color:#5c4433;">${echapper(expire)}</td></tr>
<tr><td style="padding:8px 28px 0;font-family:${police};font-size:13px;line-height:1.5;color:#866a54;">${echapper(c.secret)}</td></tr>
<tr><td style="padding:8px 28px 28px;font-family:${police};font-size:13px;line-height:1.5;color:#866a54;">${echapper(c.ignorer)}</td></tr>
</table>
<p style="max-width:480px;margin:16px auto 0;font-family:${police};font-size:12px;line-height:1.5;color:#b39a83;text-align:center;">${echapper(c.pied)}</p>
</td></tr>
</table>
</body>
</html>`;

  return { subject: objet, text, html, langue: l };
}

// ---------------------------------------------------------------------------
// Contrôles : `node src/lib/courriel-contenu.mjs`.
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("courriel-contenu.mjs")) {
  let echecs = 0;
  const verifie = (nom, obtenu, attendu) => {
    const ok = JSON.stringify(obtenu) === JSON.stringify(attendu);
    if (!ok) echecs++;
    console.log(`${ok ? "ok   " : "ÉCHEC"} ${nom}${ok ? "" : `\n      obtenu  ${JSON.stringify(obtenu)}\n      attendu ${JSON.stringify(attendu)}`}`);
  };

  // --- La langue ------------------------------------------------------------
  verifie("rien → français", langueDepuis(undefined), "fr");
  verifie("code nu", langueDepuis("de"), "de");
  verifie("en-tête complet, ordre", langueDepuis("es-ES,es;q=0.9,en;q=0.8"), "es");
  verifie("le poids l'emporte sur l'ordre", langueDepuis("it;q=0.3,ru;q=0.9"), "ru");
  verifie("langue inconnue sautée", langueDepuis("it-IT,it;q=0.9,pt-BR;q=0.5"), "pt");
  verifie("aucune connue → français", langueDepuis("ja,ko"), "fr");
  verifie("bokmål → no", langueDepuis("nb-NO,nb;q=0.9"), "no");
  verifie("q=0 = refusée", langueDepuis("en;q=0,sv"), "sv");
  verifie("majuscules", langueDepuis("ZH-CN"), "zh");

  // --- Complétude : neuf langues pour chaque motif --------------------------
  for (const motif of Object.keys(MOTIF)) {
    const manquantes = LANGUES.filter((l) => !PAR_MOTIF[motif]?.[l] || PAR_MOTIF[motif][l].some((t) => !t));
    verifie(`${motif} : neuf langues`, manquantes, []);
  }
  verifie("phrases communes : neuf langues", LANGUES.filter((l) => !COMMUN[l]), []);

  // --- Le contenu -----------------------------------------------------------
  const c = contenuCode({ motif: MOTIF.MOT_DE_PASSE, code: "482913", dureeMinutes: 10, langue: "fr-FR,fr;q=0.9" });
  verifie("objet propre au motif", c.subject, "Réinitialisation de votre mot de passe Alanya Work");
  verifie("le code est dans le texte", c.text.includes("482913"), true);
  verifie("le code est dans le HTML", c.html.includes("482913"), true);
  verifie("le code n'est PAS dans l'objet", c.subject.includes("482913"), false);
  verifie("durée dans le texte", c.text.includes("10 minutes"), true);
  verifie("langue du document", c.html.includes('<html lang="fr">'), true);
  const en = contenuCode({ motif: MOTIF.DOUBLE_AUTH, code: "1", dureeMinutes: 4.6, langue: "en" });
  verifie("anglais, durée arrondie", en.text.includes("expires in 5 minutes"), true);
  verifie("motif inconnu → texte d'inscription", contenuCode({ motif: "X", code: "1", dureeMinutes: 1 }).subject, "Votre code de création de compte Alanya Work");
  verifie("HTML échappé", contenuCode({ motif: MOTIF.INSCRIPTION, code: "<b>", dureeMinutes: 1 }).html.includes("&lt;b&gt;"), true);
  verifie("étiquette", etiquetteDuMotif(MOTIF.CHANGEMENT_ADRESSE), "work-changement-adresse");

  console.log(echecs === 0 ? "\nTous les contrôles passent." : `\n${echecs} ÉCHEC(S).`);
  process.exit(echecs === 0 ? 0 : 1);
}
