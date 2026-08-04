import { z } from "zod";

/// `max(100)` est aligné sur la colonne `users.email`, ramenée à VARCHAR(100)
/// pour suivre le référentiel équipe. Sans cette borne, un email plus long
/// passerait la validation puis ferait échouer l'insertion : erreur 500 au lieu
/// d'un message clair.
///
/// ⚠️ La RFC 5321 autorise jusqu'à 254 caractères. 100 suffit largement en
/// pratique — la plus longue adresse en base fait 49 caractères — mais une
/// adresse légitime très longue serait désormais refusée. C'est une contrainte
/// du référentiel, pas un choix de ce dépôt.
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Email invalide")
  .max(100, "Email trop long (100 caractères maximum)");

export const registerSchema = z.object({
  email: emailSchema,
});

export const verifySchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, "Le code doit comporter 6 chiffres"),
});

/**
 * Identifiant stable de l'appareil, tel que le client le conserve
 * (`cookies_WebID` en localStorage sur le web, SharedPreferences sur mobile).
 *
 * Il rattache la session emise a une ligne du registre `Appareil`, ce qui rend
 * la revocation a distance possible : sans lui, le serveur sait quel
 * utilisateur possede un jeton, mais pas depuis quel appareil il a ete obtenu.
 *
 * Facultatif a dessein — un client plus ancien continue de se connecter, sa
 * session ne sera simplement pas revocable individuellement.
 */
const deviceIdSchema = z.string().trim().min(8).max(255).optional();

export const setupSchema = z.object({
  // Reste OBLIGATOIRE : le formulaire ne le demande plus, mais il y recopie le
  // nom avant l'envoi. Le contrat d'API est donc inchangé, et un client plus
  // ancien qui envoie un vrai pseudo continue de fonctionner.
  //
  // 50 et non 100 : c'est la longueur de la colonne users.pseudo depuis le
  // 30/07/2026. Laisser 100 ici ferait passer la validation puis échouer
  // l'insertion en base, et l'utilisateur récupérerait une erreur 500 au lieu
  // d'un message clair. ⚠️ Le nom, lui, va jusqu'à 100 : le client doit donc
  // TRONQUER avant de le recopier ici.
  pseudo: z.string().trim().min(2, "Pseudo trop court").max(50, "Pseudo trop long (50 caractères maximum)"),
  password: z.string().min(8, "Le mot de passe doit faire au moins 8 caractères").max(128),
  nom: z.string().trim().min(1, "Le nom est requis").max(100).optional(),
  // Numéro de téléphone personnel, distinct de l'Alanya ID. 20 caractères,
  // longueur relevée sur la colonne users.mobile — au-delà, la validation
  // passerait et l'insertion échouerait.
  //
  // Facultatif ICI et obligatoire dans le formulaire, comme demandé : le
  // serveur reste tolérant pour ne pas rejeter les clients plus anciens, et
  // c'est l'interface qui impose la saisie.
  mobile: z.string().trim().min(1).max(20, "Téléphone trop long (20 caractères maximum)").optional(),
  idPays: z.number().int().positive().optional(),
  deviceId: deviceIdSchema,
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Identifiant requis"),
  password: z.string().min(1, "Mot de passe requis"),
  deviceId: deviceIdSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const publicNumberSchema = z.string().trim().regex(/^(\d{6}|\d{8})$/, "Le numero doit comporter 6 ou 8 chiffres");

export const updateProfileSchema = z.object({
  // Aligné sur la longueur de la colonne — voir setupSchema.
  pseudo: z.string().trim().min(2).max(50, "Pseudo trop long (50 caractères maximum)").optional(),
  avatarUrl: z.string().trim().max(2048).regex(/^(https?:\/\/[^\s]+|\/api\/media\/[a-zA-Z0-9-]+)$/, "avatarUrl invalide").nullable().optional(),
  statusMsg: z.string().trim().max(255).nullable().optional(),
});

export const addContactSchema = z.object({
  publicNumber: publicNumberSchema.optional(),
  number: publicNumberSchema.optional(),
  alias: z.string().trim().max(100).optional(),
}).transform((d) => ({
  publicNumber: (d.publicNumber ?? d.number) as string,
  alias: d.alias,
})).refine((d) => Boolean(d.publicNumber), {
  message: "publicNumber est requis (6 chiffres)",
  path: ["publicNumber"],
});

export const updateContactSchema = z.object({
  alias: z.string().trim().max(100).nullable().optional(),
  isBlocked: z.boolean().optional(),
});

export const blockUserSchema = z.object({
  publicNumber: publicNumberSchema,
});

export const createConversationSchema = z.object({
  publicNumber: publicNumberSchema.optional(),
  name: z.string().trim().min(1).max(150).optional(),
  memberNumbers: z.array(publicNumberSchema).max(256).optional(),
}).refine((d) => d.publicNumber || (d.name && d.memberNumbers && d.memberNumbers.length > 0), {
  message: "Fournir un publicNumber (direct) ou name + memberNumbers (groupe)",
});

export const sendMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000).optional(),
  type: z.enum(["TEXT", "IMAGE", "FILE", "AUDIO", "VIDEO"]).default("TEXT"),
  mediaId: z.string().uuid().optional(),
  mediaIds: z.array(z.string().uuid()).max(10).optional(),
  replyToId: z.string().uuid().optional(),
});

export const createStatusSchema = z.object({
  type: z.enum(["TEXT", "IMAGE", "VIDEO"]).default("TEXT"),
  text: z.string().trim().min(1).max(700).optional(),
  bgColor: z.string().trim().regex(/^#?[0-9a-fA-F]{6,8}$/, "Couleur invalide").max(9).optional(),
  mediaId: z.string().uuid().optional(),
}).refine((d) => (d.type === "TEXT" ? Boolean(d.text) : Boolean(d.mediaId)), {
  message: "Un statut TEXT requiert text ; IMAGE/VIDEO requiert mediaId",
});

export const aiChatSchema = z.object({
  message: z.string().trim().min(1, "Message vide").max(8000),
});

export const createCallSchema = z.object({
  convId: z.string().uuid(),
  type: z.enum(["AUDIO", "VIDEO"]).default("AUDIO"),
});

export const callIdSchema = z.object({
  callId: z.string().uuid(),
});

export const createPaysSchema = z.object({
  libelle: z.string().trim().min(1, "Le libelle est requis").max(200),
  prefix: z.string().trim().min(1, "Le prefixe est requis").max(10),
  timeZone: z.string().trim().min(1, "Le fuseau horaire est requis").max(200),
  decalageHoraire: z.number().int().min(-720).max(840),
});

export const updatePaysSchema = createPaysSchema.partial();

export const createMeetingSchema = z.object({
  objet: z.string().trim().min(1, "L'objet est requis").max(200),
  type_media: z.number().int().min(1).max(2),
  start_time: z.string().datetime().optional(),
  duree: z.number().int().min(1).max(86400).default(3600),
  room: z.string().trim().max(200).optional(),
  participantIds: z.array(z.string().uuid()).optional(),
  participantNumbers: z.array(publicNumberSchema).optional(),
});
