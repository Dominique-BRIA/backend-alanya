import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email("Email invalide");

export const registerSchema = z.object({
  email: emailSchema,
});

export const verifySchema = z.object({
  email: emailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Le code doit comporter 6 chiffres"),
});

export const setupSchema = z.object({
  pseudo: z.string().trim().min(2, "Pseudo trop court").max(100),
  password: z
    .string()
    .min(8, "Le mot de passe doit faire au moins 8 caractères")
    .max(128),
});

// Connexion par email OU par numéro public à 6 chiffres.
export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Identifiant requis"),
  password: z.string().min(1, "Mot de passe requis"),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

// --- Profil & contacts ---

export const publicNumberSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Le numéro doit comporter 6 chiffres");

export const updateProfileSchema = z.object({
  pseudo: z.string().trim().min(2).max(100).optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
  statusMsg: z.string().trim().max(255).nullable().optional(),
});

export const addContactSchema = z
  .object({
    publicNumber: publicNumberSchema.optional(),
    number: publicNumberSchema.optional(),
    alias: z.string().trim().max(100).optional(),
  })
  .transform((d) => ({
    publicNumber: (d.publicNumber ?? d.number) as string,
    alias: d.alias,
  }))
  .refine((d) => Boolean(d.publicNumber), {
    message: "publicNumber est requis (6 chiffres)",
    path: ["publicNumber"],
  });

export const updateContactSchema = z.object({
  alias: z.string().trim().max(100).nullable().optional(),
  isBlocked: z.boolean().optional(),
});

// --- Messagerie ---

export const createConversationSchema = z
  .object({
    // Conversation directe : numéro public de l'autre personne.
    publicNumber: publicNumberSchema.optional(),
    // Conversation de groupe : nom + membres (numéros publics).
    name: z.string().trim().min(1).max(150).optional(),
    memberNumbers: z.array(publicNumberSchema).max(256).optional(),
  })
  .refine((d) => d.publicNumber || (d.name && d.memberNumbers && d.memberNumbers.length > 0), {
    message: "Fournir un publicNumber (direct) ou name + memberNumbers (groupe)",
  });

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000).optional(),
  type: z.enum(["TEXT", "IMAGE", "FILE", "AUDIO", "VIDEO"]).default("TEXT"),
  mediaId: z.string().uuid().optional(),
  replyToId: z.string().uuid().optional(),
});

// --- Statuts (stories éphémères 24 h) ---

export const createStatusSchema = z
  .object({
    type: z.enum(["TEXT", "IMAGE", "VIDEO"]).default("TEXT"),
    text: z.string().trim().min(1).max(700).optional(),
    // Couleur de fond hex (#RRGGBB ou #AARRGGBB) pour les statuts texte.
    bgColor: z
      .string()
      .trim()
      .regex(/^#?[0-9a-fA-F]{6,8}$/, "Couleur invalide")
      .max(9)
      .optional(),
    mediaId: z.string().uuid().optional(),
  })
  .refine((d) => (d.type === "TEXT" ? Boolean(d.text) : Boolean(d.mediaId)), {
    message: "Un statut TEXT requiert 'text' ; IMAGE/VIDEO requiert 'mediaId'",
  });

// --- IA conversationnelle (Gemini) ---

export const aiChatSchema = z.object({
  message: z.string().trim().min(1, "Message vide").max(8000),
});

// --- Appels (WebRTC) ---

export const createCallSchema = z.object({
  convId: z.string().uuid(),
  type: z.enum(["AUDIO", "VIDEO"]).default("AUDIO"),
});

export const callIdSchema = z.object({
  callId: z.string().uuid(),
});
