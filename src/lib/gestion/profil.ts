import { permissionsDe } from "./permissions";
import { type SessionAdmin } from "./session";

/**
 * Le profil d'un superroot, dans la forme qu'attend la console
 * (`AdminProfile` de Chris-Manuelpipo/Alanya-admin).
 *
 * Elle a été écrite pour des comptes UTILISATEURS promus admin ; un superroot
 * n'est pas un utilisateur et n'a ni nom, ni e-mail, ni téléphone, ni avatar.
 * Les champs absents valent `null` plutôt que d'être inventés, sauf ceux
 * qu'alanyaCenter remplit déjà pour ce même compte (`nom`), pour que l'admin
 * se reconnaisse d'une console à l'autre.
 *
 * ⚠️ `alanyaID` N'EST PAS UN IDENTIFIANT D'UTILISATEUR : préfixé (`root-3`,
 * `master`), il ne peut correspondre à aucun compte de `users`. Un écran qui
 * l'utiliserait pour « ne pas se bannir soi-même » ne trouvera jamais de
 * correspondance — ce qui est juste : un superroot n'a pas de compte à bannir.
 */
export function profilAdmin(session: SessionAdmin) {
  return {
    alanyaID: session.isMaster ? "master" : `root-${session.idRoot}`,
    idRoot: session.idRoot,
    nom: session.isMaster ? "Master Super Root" : "Super Root",
    pseudo: session.username,
    username: session.username,
    email: null,
    alanyaPhone: null,
    avatarUrl: null,
    // 2 = super-admin dans la console : c'est ce qui ouvre ses écrans réservés.
    typeCompte: 2,
    type: session.type,
    isMaster: session.isMaster,
    lectureSeule: session.lectureSeule,
    permissions: permissionsDe(),
    paysLibelle: null,
    createdAt: null,
    lastSeen: null,
  };
}
