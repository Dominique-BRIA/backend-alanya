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

  mail: {
    // auto | firebase | smtp | console
    provider: () => optional("MAIL_PROVIDER", "smtp").toLowerCase(),
    host: optional("SMTP_HOST"),
    port: Number(optional("SMTP_PORT", "587")),
    user: optional("SMTP_USER"),
    pass: optional("SMTP_PASS"),
    from: optional("MAIL_FROM", "Alanya <no-reply@alanya.app>"),
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

  gemini: {
    apiKey: optional("GEMINI_API_KEY"),
    // gemini-1.5-flash et gemini-2.0-flash ont été retirés ; on cible un modèle
    // stable et actuel (surchargeable via GEMINI_MODEL, ex. gemini-3.5-flash).
    model: optional("GEMINI_MODEL", "gemini-2.5-flash"),
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
