import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { CODE_LIEN_REGEX } from "@/lib/groupe-adhesion";
import { PageLien } from "../../_liens/PageLien";

/**
 * GET /g/<code> — le lien (et le QR code) d'un groupe (18/11/2026).
 *
 * Page de SECOURS, comme `/u/<ID>` et `/i/<jeton>` : quand Alanya Work est
 * installé, Android ouvre le lien dans l'application, qui montre le groupe et
 * fait entrer (public) ou demander (privé) après confirmation.
 *
 * Elle donne le nom du groupe — c'est ce qu'on attend d'une invitation — mais
 * ni sa photo ni ses membres : le lien circule hors du groupe. Elle ne fait
 * rien entrer : il faut un compte connecté
 * (POST /api/groupes/lien/<code>/rejoindre).
 *
 * « Continuer sur le web » ouvre la même invitation dans le client web.
 */

const ORIGINE = "https://alanyavox.com";

type Params = { params: Promise<{ code: string }> };

export const metadata: Metadata = {
  title: "Invitation à un groupe Alanya Work",
  description: "Rejoindre un groupe sur Alanya Work.",
  openGraph: {
    title: "Invitation à un groupe Alanya Work",
    description: "Rejoindre un groupe sur Alanya Work.",
    images: [`${ORIGINE}/logo-alanya.png`],
    siteName: "Alanya Work",
  },
};

export default async function PageGroupe({ params }: Params) {
  const { code } = await params;
  if (!CODE_LIEN_REGEX.test(code)) notFound();

  const conv = await prisma.conversation.findUnique({
    where: { codeLien: code },
    select: { isGroup: true, name: true, acces: true },
  });

  const agent = (await headers()).get("user-agent") ?? "";
  const android = /android/i.test(agent);

  if (!conv?.isGroup) {
    return (
      <PageLien
        titre="Ce lien de groupe n'est plus valable"
        sousTitre="Il a peut-être été renouvelé. Demandez le nouveau lien à un membre du groupe."
        chemin={`/g/${code}`}
        origine={ORIGINE}
        android={false}
      />
    );
  }

  return (
    <PageLien
      titre={conv.name ? `Rejoindre « ${conv.name} »` : "Rejoindre un groupe"}
      sousTitre={
        conv.acces === "public"
          ? "Groupe public : vous en devenez membre dès que vous confirmez."
          : "Groupe privé : un administrateur doit accepter votre demande."
      }
      chemin={`/g/${code}`}
      origine={ORIGINE}
      android={android}
      web={`/webapp/g/${code}`}
    />
  );
}
