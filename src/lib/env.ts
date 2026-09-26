// Accès centralisé et typé aux variables d'environnement.
// On échoue tôt (au démarrage) si une variable critique manque.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante : ${name}`);
  }
  return value;
}

function optional(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProd: process.env.NODE_ENV === "production",

  databaseUrl: () => required("DATABASE_URL"),

  /// Origine publique du serveur, utilisée pour bâtir les URL renvoyées aux
  /// clients. Elle vit ici et NON dans les données : le jour où le domaine
  /// change, ou où les fichiers passent derrière un serveur dédié, c'est cette
  /// seule valeur qui bouge — aucune ligne à migrer.
  /// Sans barre finale : les chemins qu'on lui accole commencent par « / ».
  publicBaseUrl: optional("PUBLIC_BASE_URL", "https://alanyavox.com").replace(/\/+$/, ""),

  jwt: {
    accessSecret: () => required("JWT_ACCESS_SECRET"),
    refreshSecret: () => required("JWT_REFRESH_SECRET"),
    accessTtl: optional("JWT_ACCESS_TTL", "15m"),
    refreshTtl: optional("JWT_REFRESH_TTL", "7d"),
  },

  otp: {
    ttlMinutes: Number(optional("OTP_TTL_MINUTES", "10")),
  },

  /// Courrier sortant. Qui envoie : `choisirFournisseur` (src/lib/courriel.mjs).
  mail: {
    // postmark | smtp | auto. Absent = auto : Postmark dès que son jeton est
    // posé, sinon SMTP. `smtp` force l'ancien relais — c'est le retour arrière.
    provider: () => optional("MAIL_PROVIDER", "auto"),
    host: optional("SMTP_HOST"),
    port: Number(optional("SMTP_PORT", "587")),
    user: optional("SMTP_USER"),
    pass: optional("SMTP_PASS"),
    // Expéditeur du relais SMTP. Gmail réécrit tout autre expéditeur que le
    // compte lui-même : il reste donc distinct de celui de Postmark, et revenir
    // en arrière ne demande de toucher qu'à MAIL_PROVIDER.
    from: optional("MAIL_FROM", "Alanya <no-reply@alanya.app>"),

    postmark: {
      // Jeton du SERVEUR Postmark (onglet API Tokens du serveur), pas celui du
      // compte. Il ne sait qu'envoyer — contrairement au mot de passe Gmail.
      serverToken: () => optional("POSTMARK_SERVER_TOKEN"),
      // Doit appartenir à un domaine VÉRIFIÉ dans Postmark (DKIM posé), sinon
      // chaque envoi est refusé (ErrorCode 400).
      from: () => optional("POSTMARK_FROM", "Alanya <no-reply@alanyavox.com>"),
      // Flux transactionnel créé d'office avec chaque serveur Postmark.
      messageStream: () => optional("POSTMARK_MESSAGE_STREAM", "outbound"),
    },
  },

  push: {
    enabled(): boolean {
      const flag = optional("PUSH_ENABLED", "false").toLowerCase();
      if (flag === "0" || flag === "false") return false;
      return Boolean(optional("FIREBASE_SERVICE_ACCOUNT_BASE64"));
    },
  },

  firebase: {
    serviceAccountBase64: () => optional("FIREBASE_SERVICE_ACCOUNT_BASE64"),
    projectId: () => optional("FIREBASE_PROJECT_ID"),
    mailCollection: () => optional("FIREBASE_MAIL_COLLECTION", "mail"),
    isConfigured(): boolean {
      return Boolean(optional("FIREBASE_SERVICE_ACCOUNT_BASE64"));
    },
  },

  /// L'assistant intégré. Voir `src/lib/assistant.ts`, seul fichier qui sait
  /// quel service répond réellement.
  ///
  /// ⚠️ DEUX NOMS ACCEPTÉS POUR CHAQUE VALEUR, et l'ancien vient en second.
  /// Les `.env` déjà en place — production comprise — portent les noms de
  /// l'époque où le fournisseur était nommé partout. Les renommer d'autorité
  /// aurait vidé la clé au premier déploiement, et l'assistant serait tombé en
  /// « indisponible » sans que rien ne l'explique. Le jour où les `.env` sont
  /// migrés, la seconde forme peut disparaître.
  assistant: {
    apiKey: optional("ASSISTANT_API_KEY") || optional("GEMINI_API_KEY"),
    // Modèle courant, surchargeable sans redéploiement.
    model:
      optional("ASSISTANT_MODEL") ||
      optional("GEMINI_MODEL") ||
      "gemini-2.5-flash",
  },

  media: {
    storageDir: optional("MEDIA_STORAGE_DIR", "./storage/media"),
    maxSizeMb: Number(optional("MEDIA_MAX_SIZE_MB", "50")),
    // Backend de stockage : "local" (défaut) ou "b2" (Backblaze B2 cloud).
    provider: optional("MEDIA_STORAGE_PROVIDER", "local").toLowerCase() as "local" | "b2",

    // Configuration Backblaze B2 (API compatible S3).
    b2: {
      endpoint: optional("B2_ENDPOINT", "s3.us-west-004.backblazeb2.com"),
      region: optional("B2_REGION", "us-west-004"),
      bucket: optional("B2_BUCKET", "alanya"),
      keyId: optional("B2_KEY_ID"),
      applicationKey: optional("B2_APPLICATION_KEY"),
      // Préfixe appliqué à toutes les clés d'objets dans le bucket (organisation).
      keyPrefix: optional("B2_KEY_PREFIX", "media/"),
      // Durée de validité des URLs présignées (en secondes) — 1h par défaut.
      presignExpiresInSec: Number(optional("B2_PRESIGN_EXPIRES_IN_SEC", "3600")),
      isConfigured(): boolean {
        return Boolean(
          optional("B2_BUCKET") && optional("B2_KEY_ID") && optional("B2_APPLICATION_KEY"),
        );
      },
    },

    /**
     * LE BUCKET PUBLIC — accueils de répondeur et sonneries.
     *
     * 🔴 CE QUI Y VA EST LU PAR N'IMPORTE QUI, SANS COMPTE. C'est tout
     * l'intérêt : plus d'URL signée, plus d'aller-retour par le serveur, et le
     * navigateur peut garder le fichier en cache. Un accueil doit démarrer à
     * l'instant où la sonnerie s'arrête — chaque étape supprimée compte.
     *
     * ⚠️ ET C'EST AUSSI TOUT LE DANGER. N'y placer QUE ce qui est de toute
     * façon entendu par tous les appelants : l'accueil qu'on enregistre, la
     * sonnerie qu'on choisit. JAMAIS un message laissé PAR quelqu'un — c'est un
     * enregistrement privé, il reste dans le bucket fermé.
     *
     * ⚠️ SA PROPRE CLÉ. Une clé Backblaze vise UN bucket, ou TOUS. Prendre
     * « tous » donnerait accès à des buckets qui ne sont pas les nôtres ; on
     * crée donc une seconde clé, limitée à celui-ci.
     *
     * Non configuré = tout retombe dans le bucket privé, et rien ne casse.
     */
    b2Public: {
      bucket: optional("B2_PUBLIC_BUCKET"),
      keyId: optional("B2_PUBLIC_KEY_ID"),
      applicationKey: optional("B2_PUBLIC_APPLICATION_KEY"),
      keyPrefix: optional("B2_PUBLIC_KEY_PREFIX", "public/"),
      isConfigured(): boolean {
        return Boolean(
          optional("B2_PUBLIC_BUCKET") &&
            optional("B2_PUBLIC_KEY_ID") &&
            optional("B2_PUBLIC_APPLICATION_KEY"),
        );
      },
    },
  },

  // Serveurs ICE : uniquement via Coturn avec identifiants HMAC éphémères
  // (route /api/calls/ice). C'est suffisant et plus sûr que des identifiants
  // statiques. Les anciennes variables TURN_URL/TURN_USERNAME/TURN_CREDENTIAL et
  // le helper env.webrtc.iceServers() (code mort) ont été retirés.
  coturn: {
    secret: () => optional("COTURN_SECRET", "alanya1960-Secure"),
    domains: () => optional("COTURN_DOMAINS", "alanya226.com,kemita.eu").split(",").map(d => d.trim()),
  },
} as const;
