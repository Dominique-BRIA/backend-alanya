/**
 * Démarrage du serveur Next — tâches de fond.
 *
 * Next appelle `register()` une fois par processus. On n'y lance que ce qui
 * DOIT vivre côté API, faute d'accès ailleurs : l'effacement des fichiers à
 * vue unique passe par le module de stockage (TypeScript), que le serveur
 * WebSocket (`ws-server.mjs`, JavaScript pur) ne peut pas importer.
 */
export async function register() {
  // Pas dans le runtime « edge » : ni Prisma ni le stockage n'y tournent.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { purgerVuesUniques } = await import("@/modules/messaging/vue-unique");

  /*
   * LA PURGE DE SECOURS DES VUES UNIQUES, toutes les 5 minutes.
   *
   * Le chemin normal efface à la fermeture du visionneur. Celle-ci rattrape
   * l'application tuée avant de le dire, et les médias jamais ouverts depuis
   * 14 jours. Un échec n'arrête rien : il sera retenté au tour suivant.
   */
  const tour = () =>
    purgerVuesUniques()
      .then((n) => {
        if (n > 0) console.log(`[vue-unique] fichiers effacés : ${n}`);
      })
      .catch((e) => console.error("[vue-unique] purge :", e));
  setTimeout(tour, 30_000);
  setInterval(tour, 5 * 60 * 1000).unref?.();

  /*
   * LES DIFFUSIONS DU COMPTE OFFICIEL, toutes les 30 secondes (console de
   * gestion, 16/10/2026).
   *
   * Lance les diffusions planifiées arrivées à échéance, et REPREND celles
   * qu'un redémarrage a interrompues (leur verrou expire). Une diffusion
   * immédiate n'attend pas ce tour : sa route la lance juste après avoir
   * répondu — ce tour-ci n'est que le filet.
   */
  const { traiterDiffusionsDues } = await import("@/lib/gestion/diffusions");
  const { poursuivreRattrapage } = await import("@/lib/gestion/bienvenue");
  setInterval(() => {
    traiterDiffusionsDues()
      .then((n) => {
        if (n > 0) console.log(`[diffusion] traitées : ${n}`);
      })
      .catch((e) => console.error("[diffusion] tour :", e));
    // Le rattrapage de la bienvenue demandé depuis la console, s'il reste à faire.
    poursuivreRattrapage()
      .then((n) => {
        if (n > 0) console.log(`[bienvenue] rattrapage : ${n} compte(s) servi(s)`);
      })
      .catch((e) => console.error("[bienvenue] rattrapage :", e));
  }, 30_000).unref?.();

  /*
   * LES PURGES DE LA CONSOLE, une fois par heure : chacune décide elle-même si
   * son dernier passage automatique date de plus d'un jour.
   */
  const { purgesAutomatiques } = await import("@/lib/gestion/purges");
  setInterval(() => {
    purgesAutomatiques().catch((e) => console.error("[purges] tour :", e));
  }, 60 * 60 * 1000).unref?.();
}
