/**
 * LES LIENS UNIVERSELS DE L'iPHONE (19/11/2026) — l'équivalent iOS de
 * `public/.well-known/assetlinks.json`.
 *
 * iOS lit `https://alanyavox.com/.well-known/apple-app-site-association`
 * (réécrit ici par `next.config.ts`) pour savoir que les liens `/u/…`,
 * `/i/…` et `/g/…` s'ouvrent dans Alanya Work. Le fichier doit être du JSON
 * servi tel quel, sans redirection.
 *
 * Il dépend de l'identifiant d'ÉQUIPE Apple : tant que `APPLE_TEAM_ID` (ou
 * `APNS_TEAM_ID`) n'est pas renseigné, la route répond 404 — iOS ignore
 * alors simplement les liens, rien ne casse.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const equipe = process.env.APPLE_TEAM_ID?.trim() || process.env.APNS_TEAM_ID?.trim();
  if (!equipe) return new Response("Not found", { status: 404 });
  const application = `${equipe}.${process.env.APNS_BUNDLE_ID?.trim() || "com.alanya237.work"}`;
  return Response.json(
    {
      applinks: {
        details: [
          {
            appIDs: [application],
            components: [{ "/": "/u/*" }, { "/": "/i/*" }, { "/": "/g/*" }],
          },
        ],
      },
    },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
