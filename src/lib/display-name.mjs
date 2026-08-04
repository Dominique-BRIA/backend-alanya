/**
 * Nom sous lequel un utilisateur est présenté aux autres.
 *
 * RÈGLE MÉTIER : c'est le NOM qui s'affiche partout. Le pseudo n'est qu'un
 * libellé choisi à l'inscription ; il ne sert de repli que pour les comptes
 * créés avant que le nom ne devienne la référence, ou pour ceux qui l'ont
 * laissé vide — le champ étant facultatif, c'était le cas de 39 comptes sur 49
 * au 03/08/2026.
 *
 * ⚠️ LE RÉSULTAT ALIMENTE LE CHAMP `pseudo` DES RÉPONSES D'API, et ce n'est pas
 * une erreur. Ce champ est, depuis toujours, celui que les clients affichent
 * comme nom : le renommer casserait les trois clients d'un coup pour un gain
 * purement cosmétique. Il porte donc un nom d'héritage et un contenu à jour.
 * Le nom brut reste disponible séparément là où il faut le distinguer.
 *
 * Les chaînes vides comptent comme absentes : un nom réduit à des espaces
 * afficherait une ligne vide, ce qui est pire qu'un repli sur le pseudo.
 */
export function nomAffichage(u) {
  const nom = u.nom?.trim();
  if (nom) return nom;
  const pseudo = u.pseudo?.trim();
  if (pseudo) return pseudo;
  return u.publicNumber ?? null;
}
