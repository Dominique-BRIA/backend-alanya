import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ALANYA_ID_REGEX } from "@/lib/validation";
import { formatAlanyaId } from "@/lib/format-alanya-id.mjs";
import { PageLien } from "../../_liens/PageLien";

/**
 * GET /u/<Alanya ID> — la cible du QR code PERMANENT de l'écran Profil.
 *
 * Sur un téléphone où Alanya Work est installé, Android ouvre ce lien dans
 * l'application (déclaration `/.well-known/assetlinks.json` + filtre
 * d'intention du manifeste) : cette page ne sert que de secours.
 *
 * 🔒 AUCUNE LECTURE EN BASE, volontairement. La page n'affiche ni nom ni photo,
 * seulement l'identifiant déjà contenu dans l'adresse : sinon, n'importe qui
 * pourrait parcourir `/u/10000000`, `/u/10000001`… et relever l'annuaire des
 * comptes sans être connecté. Elle ne dit donc pas non plus si le compte
 * existe — l'application, elle, le vérifie après connexion.
 */

const ORIGINE = "https://alanyavox.com";

type Params = { params: Promise<{ numero: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { numero } = await params;
  if (!ALANYA_ID_REGEX.test(numero)) return {};
  const titre = `Écrire à ${formatAlanyaId(numero)} sur Alanya Work`;
  // L'aperçu que WhatsApp ou Facebook affichent sous un lien partagé.
  return {
    title: titre,
    description: "Ouvrez la conversation dans Alanya Work.",
    openGraph: {
      title: titre,
      description: "Ouvrez la conversation dans Alanya Work.",
      images: [`${ORIGINE}/logo-alanya.png`],
      siteName: "Alanya Work",
    },
  };
}

export default async function PageProfil({ params }: Params) {
  const { numero } = await params;
  if (!ALANYA_ID_REGEX.test(numero)) notFound();

  const agent = (await headers()).get("user-agent") ?? "";
  return (
    <PageLien
      titre={`Écrire à ${formatAlanyaId(numero)}`}
      sousTitre="sur Alanya Work"
      chemin={`/u/${numero}`}
      origine={ORIGINE}
      android={/android/i.test(agent)}
    />
  );
}
