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
}
