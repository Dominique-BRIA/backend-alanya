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
  },

  webrtc: {
    iceServers(): Array<{ urls: string | string[]; username?: string; credential?: string }> {
      const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> =
        [];

      // STUN servers (plusieurs pour la redondance)
      const stunRaw = optional("STUN_URLS",
        "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302,stun:stun.cloudflare.com:3478"
      );
      for (const url of stunRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
        servers.push({ urls: url });
      }

      // TURN server via Metered (gratuit, nécessite METERED_API_KEY)
      const meteredKey = optional("METERED_API_KEY");
      const meteredDomain = optional("METERED_DOMAIN");
      if (meteredKey && meteredDomain) {
        servers.push(
          { urls: `turn:${meteredDomain}:80`, username: "openrelayproject", credential: meteredKey },
          { urls: `turn:${meteredDomain}:443`, username: "openrelayproject", credential: meteredKey },
          { urls: `turns:${meteredDomain}:443`, username: "openrelayproject", credential: meteredKey },
        );
      }

      // TURN server manuel (optionnel)
      const turnUrl = optional("TURN_URL");
      if (turnUrl) {
        const entry: { urls: string; username?: string; credential?: string } = { urls: turnUrl };
        const user = optional("TURN_USERNAME");
        const cred = optional("TURN_CREDENTIAL");
        if (user) entry.username = user;
        if (cred) entry.credential = cred;
        servers.push(entry);
      }

      return servers;
    },
  },
} as const;
