import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { JETON_REGEX, etatInvitation } from "@/lib/invitation-qr";
import { PageLien } from "../../_liens/PageLien";

/**
 * GET /i/<jeton> — la cible d'une invitation QR à usage unique (15 minutes).
 *
 * Page de SECOURS, comme `/u/<ID>` : quand Alanya Work est installé, Android
 * ouvre le lien dans l'application, qui montre la fiche et utilise
 * l'invitation après confirmation.
 *
 * 🔒 La page ne dit PAS qui invite : ni nom, ni photo, ni Alanya ID. Le lien
 * circule dans des groupes et ses aperçus (WhatsApp, Facebook) sont vus de
 * tous ; seul un compte connecté, dans l'application, voit le créateur.
 * Elle lit seulement l'ÉTAT de l'invitation, pour ne pas proposer d'ouvrir
 * une invitation déjà morte. Elle ne la consomme jamais : l'utilisation
 * exige une connexion (POST /api/invitations/<jeton>/utiliser).
 */

const ORIGINE = "https://alanyavox.com";

type Params = { params: Promise<{ jeton: string }> };

export const metadata: Metadata = {
  title: "Invitation Alanya Work",
  description: "Une invitation à discuter sur Alanya Work (usage unique, 15 minutes).",
  openGraph: {
    title: "Invitation Alanya Work",
    description: "Une invitation à discuter sur Alanya Work (usage unique, 15 minutes).",
    images: [`${ORIGINE}/logo-alanya.png`],
    siteName: "Alanya Work",
  },
};

export default async function PageInvitation({ params }: Params) {
  const { jeton } = await params;
  if (!JETON_REGEX.test(jeton)) notFound();

  const inv = await prisma.invitationQr.findUnique({
    where: { jeton },
    select: { expireLe: true, utiliseeLe: true },
  });
  if (!inv) notFound();

  const agent = (await headers()).get("user-agent") ?? "";
  const android = /android/i.test(agent);
  const etat = etatInvitation(inv);

  if (etat !== "valide") {
    return (
      <PageLien
        titre="Cette invitation n'est plus valable"
        sousTitre={
          etat === "utilisee"
            ? "Elle a déjà été utilisée. Demandez-en une nouvelle."
            : "Elle a expiré. Demandez-en une nouvelle."
        }
        chemin={`/i/${jeton}`}
        origine={ORIGINE}
        // Rien à ouvrir dans l'application : seule la sortie web reste.
        android={false}
      />
    );
  }

  return (
    <PageLien
      titre="Vous êtes invité sur Alanya Work"
      sousTitre="Invitation à usage unique, valable 15 minutes"
      chemin={`/i/${jeton}`}
      origine={ORIGINE}
      android={android}
    />
  );
}
