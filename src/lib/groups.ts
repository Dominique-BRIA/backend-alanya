// Détection d'admin de groupe, avec repli historique : si le groupe n'a AUCUN
// participant ADMIN (anciens groupes créés avant la gestion des rôles), le
// premier membre fait office d'admin. Centralisé ici pour rester cohérent entre
// ajout / retrait / changement de rôle.
//
// ⚠️ LES ANCIENS MEMBRES SONT ÉCARTÉS ICI MÊME (09/10/2026) : un administrateur
// parti n'est plus administrateur, et le repli « premier membre » ne doit pas
// désigner quelqu'un qui a quitté le groupe.
type ParticipantLike = { userId: string; role: string; estMembre?: boolean };

export function isGroupAdmin(
  tous: ParticipantLike[],
  userId: string,
): boolean {
  const participants = tous.filter((p) => p.estMembre !== false);
  const me = participants.find((p) => p.userId === userId);
  if (!me) return false;
  if (me.role === "ADMIN") return true;
  const hasAdmin = participants.some((p) => p.role === "ADMIN");
  return !hasAdmin && participants[0]?.userId === userId;
}
