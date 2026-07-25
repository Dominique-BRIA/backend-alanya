// Détection d'admin de groupe, avec repli historique : si le groupe n'a AUCUN
// participant ADMIN (anciens groupes créés avant la gestion des rôles), le
// premier membre fait office d'admin. Centralisé ici pour rester cohérent entre
// ajout / retrait / changement de rôle.
type ParticipantLike = { userId: string; role: string };

export function isGroupAdmin(
  participants: ParticipantLike[],
  userId: string,
): boolean {
  const me = participants.find((p) => p.userId === userId);
  if (!me) return false;
  if (me.role === "ADMIN") return true;
  const hasAdmin = participants.some((p) => p.role === "ADMIN");
  return !hasAdmin && participants[0]?.userId === userId;
}
