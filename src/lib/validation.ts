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

/**
 * Famille de l'appareil qui se connecte — 0 = web, 1 = Android, 2 = iOS,
 * 3 = bureau, mêmes valeurs que `Appareil.typeDevice`.
 *
 * Facultatif à dessein : un client plus ancien continue de se connecter. Le
 * serveur retombe alors sur ce que le registre sait déjà de cet appareil, et
 * n'évince personne s'il ne sait rien — mieux vaut une session de trop qu'un
 * utilisateur éjecté de son ordinateur parce qu'il a ouvert son téléphone.
 */
const typeDeviceSchema = z.number().int().min(0).max(9).optional();

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
  // Pas de `typeDevice` ici : `setup` configure un compte qui vient d'être créé
  // et n'a encore aucun mot de passe (`ALREADY_SETUP` l'interdit ensuite). Il ne
  // peut donc exister aucune autre session à évincer.
  deviceId: deviceIdSchema,
});

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Identifiant requis"),
  password: z.string().min(1, "Mot de passe requis"),
  deviceId: deviceIdSchema,
  typeDevice: typeDeviceSchema,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

/**
 * Longueurs acceptées pour un Alanya ID **référencé** (recherche, contact,
 * membre de groupe, invitation d'appel, participant de réunion).
 *
 * ⚠️ À ne pas confondre avec la GÉNÉRATION, qui reste à 8 chiffres
 * (`src/lib/publicNumber.ts`). Ce schéma dit ce qu'on accepte de DÉSIGNER, pas
 * ce qu'on fabrique.
 *
 * La règle était « 6 ou 8 chiffres exactement », et elle rendait des comptes
 * réels injoignables : les **numéros de centre d'appels font 4 chiffres**
 * (`0000` en production), tout comme les numéros courts d'entreprise
 * (`company.numero_court`, `6938`). Le serveur répondait `422 BAD_NUMBER` sur
 * un compte qui existe pourtant en base — un refus qui ne portait sur rien
 * d'autre que la longueur.
 *
 * 3 au minimum : en deçà, la saisie ne peut pas être un identifiant. 10 au
 * maximum : c'est le plafond que le client web s'est déjà donné, et la colonne
 * `users.alanyaPhone` est en `VarChar(20)`. Les deux bornes vivent ici, et
 * nulle part ailleurs.
 */
export const ALANYA_ID_MIN_LENGTH = 3;
export const ALANYA_ID_MAX_LENGTH = 10;

/** Vrai si la chaîne a la FORME d'un Alanya ID. Ne dit rien de son existence. */
export const ALANYA_ID_REGEX = new RegExp(
  `^\\d{${ALANYA_ID_MIN_LENGTH},${ALANYA_ID_MAX_LENGTH}}$`,
);

export const publicNumberSchema = z
  .string()
  .trim()
  .regex(
    ALANYA_ID_REGEX,
    `Le numéro doit comporter ${ALANYA_ID_MIN_LENGTH} à ${ALANYA_ID_MAX_LENGTH} chiffres`,
  );

/**
 * Un relevé de position envoyé par le mobile.
 *
 * `collectedAt` est l'heure du RELEVÉ, pas celle de l'envoi : le téléphone met
 * ses relevés en file quand il est hors ligne, et les deux diffèrent alors de
 * plusieurs minutes. Facultatif — un client qui ne l'envoie pas est horodaté à
 * l'arrivée, ce qui reste juste tant qu'il est connecté.
 */
export const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  collectedAt: z.string().datetime().optional(),
});

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
  message: "publicNumber est requis",
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

/// Ajout de participants à une réunion existante.
///
/// Borné à 50 par appel : au-delà, ce n'est plus un ajout mais un import, et
/// autant de notifications partiraient d'un seul geste.
export const addMeetingParticipantsSchema = z.object({
  publicNumbers: z
    .array(publicNumberSchema)
    .min(1, "Au moins un participant est requis")
    .max(50),
});

/// Un participant propose UNE personne à l'organisateur.
///
/// Un seul numéro, et non un tableau : chaque proposition se tranche
/// séparément, un lot obligerait l'organisateur à accepter ou refuser en bloc.
export const createInviteRequestSchema = z.object({
  publicNumber: publicNumberSchema,
});

/// Décision de l'organisateur sur une demande.
export const decideInviteRequestSchema = z.object({
  accepter: z.boolean(),
});

export const createMeetingSchema = z.object({
  objet: z.string().trim().min(1, "L'objet est requis").max(200),
  type_media: z.number().int().min(1).max(2),
  start_time: z.string().datetime().optional(),
  duree: z.number().int().min(1).max(86400).default(3600),
  room: z.string().trim().max(200).optional(),
  participantIds: z.array(z.string().uuid()).optional(),
  participantNumbers: z.array(publicNumberSchema).optional(),
});

/**
 * Tronque sur les CARACTERES, et non sur les unites UTF-16.
 *
 * `slice()` compte en unites UTF-16 : un emoji en occupe deux, et une coupe
 * entre les deux laisse une moitie de caractere (« surrogate » orpheline) qui
 * n'est plus de l'UTF-8 valide. Postgres refuse alors la valeur et la requete
 * echoue — mesure du 17/08/2026 : un nom de 79 « x » suivis de U+1F600 faisait
 * repondre « unexpected end of hex escape », donc un 400 portant un message
 * interne, et la liste etait perdue. Exactement ce que la troncature devait
 * eviter.
 *
 * L'iterateur de chaine parcourt les POINTS DE CODE, qui sont aussi l'unite que
 * compte `VARCHAR(n)` cote Postgres : la borne d'ici est donc precisement celle
 * de la colonne, ni plus large ni plus etroite.
 *
 * ⚠️ Une suite de plusieurs points de code (drapeau, emoji compose par ZWJ) peut
 * encore etre coupee en son milieu et changer d'apparence. C'est admis : le
 * resultat reste de l'UTF-8 valide, la base l'accepte, et seul ce dernier point
 * comptait ici.
 */
export function tronqueCaracteres(valeur: string, max: number): string {
  const caracteres = [...valeur];
  return caracteres.length <= max ? valeur : caracteres.slice(0, max).join("");
}

/// --- Listes de contacts ---
///
/// Les trois champs texte sont COUPES a la longueur de leur colonne au lieu
/// d'etre refuses : un nom trop long est une maladresse de saisie, pas une
/// requete invalide, et un 422 ferait perdre la liste entiere que l'utilisateur
/// vient de composer. Seul un nom vide est refuse — il n'y aurait plus rien a
/// afficher.
const nomListeSchema = z
  .string()
  .trim()
  .min(1, "Le nom de la liste est requis")
  .transform((s) => tronqueCaracteres(s, 80));

/// Le contenu n'est pas verifie : nom de fichier livre avec le client ou URL de
/// media relative, l'espace de noms est tenu cote client. Voir [ContactList].
const sonnerieListeSchema = z.string().trim().transform((s) => tronqueCaracteres(s, 300));

const couleurListeSchema = z.string().trim().transform((s) => tronqueCaracteres(s, 20));

/// `memberIds` accepte des chaines quelconques et non `uuid()` : le serveur ne
/// retient de toute facon que les identifiants qui sont deja des contacts de
/// l'appelant, et ecarte le reste en silence. Refuser sur la forme ferait echouer
/// tout l'enregistrement pour un seul identifiant perime cote client.
const membresListeSchema = z.array(z.string()).max(512, "Trop de membres pour une liste");

/// Numeros Alanya COMPOSES au clavier. Le membre correspondant n'a pas besoin
/// d'etre au repertoire de l'appelant : c'est tout l'objet de ce champ.
///
/// `publicNumberSchema` et pas autre chose : la resolution numero -> compte est
/// celle de POST /api/contacts (voir `comptesParNumerosPublics`), elle doit donc
/// accepter exactement les memes saisies. Un numero ajoutable au repertoire mais
/// refuse ici — ou l'inverse — serait incomprehensible pour l'utilisateur.
const numerosListeSchema = z
  .array(publicNumberSchema)
  .max(512, "Trop de numeros pour une liste");

export const createContactListSchema = z.object({
  name: nomListeSchema,
  ringtone: sonnerieListeSchema.nullable().optional(),
  color: couleurListeSchema.nullable().optional(),
  memberIds: membresListeSchema.optional(),
  memberNumbers: numerosListeSchema.optional(),
});

/// Mise a jour partielle : un champ absent reste inchange. `memberIds` ou
/// `memberNumbers` fourni REMPLACE l'ensemble des membres par l'union des deux —
/// l'appel est idempotent, il n'ajoute pas.
export const updateContactListSchema = z.object({
  name: nomListeSchema.optional(),
  ringtone: sonnerieListeSchema.nullable().optional(),
  color: couleurListeSchema.nullable().optional(),
  memberIds: membresListeSchema.optional(),
  memberNumbers: numerosListeSchema.optional(),
});

/// --- Catalogue de sonneries importees ---

/// URL relative du media deja televerse. Le serveur en verifie la FORME et la
/// longueur, jamais le contenu : il ne va pas relire le fichier pour savoir si
/// c'est bien de l'audio.
///
/// La forme est celle que `avatarUrlSchema` accepte deja pour un media
/// (`/api/media/<id>`), amputee de la branche `https://` : une entree de
/// catalogue designe forcement un media de CE serveur, puisqu'elle nait d'un
/// POST /api/media. Contrairement au libelle, une url mal formee est REFUSEE et
/// non rabotee — une entree qui ne pointe nulle part n'a rien a faire dans un
/// catalogue, et la couper l'y ferait entrer morte.
///
/// `max(300)` avant la forme, pour que 10 Mo de chaine soient ecartes sans
/// lancer l'expression reguliere dessus.
const urlSonnerieSchema = z
  .string()
  .trim()
  .max(300, "URL de sonnerie trop longue (300 caracteres maximum)")
  .regex(/^\/api\/media\/[a-zA-Z0-9-]+$/, "URL de sonnerie invalide");

/// Nom montre dans le choix de sonnerie. COUPE a 80 caracteres au lieu d'etre
/// refuse, meme raison que pour le nom d'une liste : un nom de fichier trop long
/// est une maladresse, pas une requete invalide, et un 422 ferait perdre un
/// televersement qui a deja abouti. Vide, en revanche, il n'y aurait plus rien a
/// afficher dans le selecteur.
///
/// `tronqueCaracteres` et non `slice` : voir sa documentation, la coupe au
/// milieu d'une paire de substitution a deja fait echouer Prisma ici.
const libelleSonnerieSchema = z
  .string()
  .trim()
  .min(1, "Le nom de la sonnerie est requis")
  .transform((s) => tronqueCaracteres(s, 80));

export const createRingtoneSchema = z.object({
  url: urlSonnerieSchema,
  label: libelleSonnerieSchema,
});
