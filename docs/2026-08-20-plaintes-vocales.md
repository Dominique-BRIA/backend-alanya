# Plaintes vocales sur les centres vocaux

**Statut : livré côté serveur et mobile, en attente de configuration et de test sur appareil.**
**Date : 20/08/2026.**

Un appelant qui joint un **centre vocal** (`users.type_compte = 4`) peut désormais
taper **0** pour dicter une réclamation. Un signal sonore l'y invite, il parle,
peut se réécouter, puis envoie. La plainte est rangée en base et le fichier
audio dans le stockage des médias.

Ce document décrit **ce que vous avez à configurer** et **le format des données**,
pour que la plateforme puisse régler les centres et afficher les plaintes reçues.

---

## 1. Ce qu'il y a à faire de votre côté

### 1.1 Déposer le signal sonore — fait

Le fichier est en place :

```
/uploads/vocal_bip/vocal_bip.ogg
```

Il est **commun à tous les centres vocaux** : un seul fichier pour toute la
plateforme, il n'y a rien à configurer centre par centre. Son adresse est rangée
côté Alanya dans une variable d'environnement, pas en base.

> ⚠️ Si vous déplacez ou renommez ce fichier, **prévenez-nous** : rien ne le
> détectera. La touche 0 continuera de fonctionner, mais l'appelant n'entendra
> aucune annonce avant que l'enregistrement démarre.

### 1.2 Autoriser un agent à enregistrer ses conversations

Nouvelle colonne sur la table `center` :

| Colonne | Type | Défaut |
| --- | --- | --- |
| `enregistrement` | `boolean` | `false` |

Une ligne de `center` est déjà le triplet **(centre, touche, agent)** : le
réglage est donc **individuel par agent et par centre**, et modifier un centre
n'affecte aucun autre. Il n'y a pas de table de liaison à créer.

> ⚠️ **Cette colonne nous appartient et elle est sur votre table.** Si la
> plateforme recrée `center`, elle disparaîtra. Merci de la conserver dans vos
> scripts de création.

> **Note :** cette colonne est posée et lisible, mais **rien ne l'exploite
> encore** côté Alanya. L'enregistrement effectif des conversations agent/client
> est un chantier distinct — voir §5.

### 1.3 Ne pas utiliser la touche 0 dans `center_audio`

La touche **0** d'un centre vocal est **réservée** à l'enregistrement de
plaintes. Elle était libre au moment de la livraison (vos centres utilisent les
touches 1 à 6).

Si une ligne `center_audio` est créée avec `menunro = 0`, **son son ne sera pas
joué** : la touche ouvrira l'enregistrement, et un avertissement apparaîtra dans
nos journaux. Ce choix est délibéré — un comportement qui dépendrait de la
présence d'une ligne serait imprévisible pour l'appelant, qui entend toujours la
même annonce.

---

## 2. Le parcours de l'appelant

1. Il appelle le numéro du centre vocal et entend l'invite d'accueil.
2. Il tape **0**.
3. Le signal sonore est joué.
4. **À la fin du signal**, l'enregistrement démarre — pas avant.
5. Il parle. Un minuteur s'affiche. Il peut mettre en **pause** et reprendre.
6. Il **termine**, puis peut **réécouter**, **refaire**, ou **envoyer**.
7. À l'envoi, le fichier est téléversé puis la plainte est créée.

Le bouton **« Accueil »** reste actif à tout moment et ramène au menu.

Pendant l'enregistrement, **les autres touches sont ignorées** : un appui
distrait ne doit pas faire perdre ce qui vient d'être dicté.

Durée maximale d'une plainte : **3 minutes**. L'enregistrement s'arrête seul.

---

## 3. Le modèle de données

### 3.1 Table `voice_complaint`

| Colonne | Type | Nul | Description |
| --- | --- | --- | --- |
| `idComplaint` | `uuid` | non | Clé primaire |
| `idCompany` | `integer` | non | Entreprise **du centre**, pas de l'appelant |
| `center_alanyaID` | `uuid` | non | → `users."alanyaID"` — le centre vocal appelé |
| `user_id` | `uuid` | **oui** | → `users."alanyaID"` — l'appelant |
| `media_id` | `uuid` | non | → `media_files.id` — le fichier audio |
| `duree_ms` | `integer` | non | Durée réelle, pauses exclues |
| `statut` | `smallint` | non | `0` reçue · `1` en cours · `2` traitée · `3` rejetée |
| `cle_envoi` | `varchar(64)` | non | Clé d'idempotence, **unique** |
| `created_at` | `timestamptz` | non | Défaut `CURRENT_TIMESTAMP` |

Index : `(center_alanyaID, created_at DESC)` pour l'affichage d'un centre,
`(idCompany)`, et un index **unique** sur `cle_envoi`.

**Quelques points à connaître :**

- **Le fichier n'est jamais en base.** Seule sa référence l'est. L'audio vit
  dans `media_files`, qui porte l'URL, le type MIME et la durée.
- **`user_id` est nullable, à dessein.** Si le compte de l'appelant est
  supprimé, la plainte **survit** avec `user_id` à `NULL` : elle appartient à
  l'entreprise qui doit la traiter, pas à son auteur.
- **`idCompany` vient du centre.** La plupart des appelants n'appartiennent à
  aucune entreprise, et ceux qui en ont une n'ont pas de rapport avec le
  standard qu'ils appellent.
- **`statut` est un entier borné par une contrainte `CHECK`**, pas une `enum` :
  même convention que `meeting.status` ou `users.type_compte` chez vous.
- **`cle_envoi` garantit qu'une plainte ne peut pas être déposée deux fois.**
  C'est une contrainte en base, pas une vérification applicative : un réseau qui
  hésite, un double appui ou un réessai ne produisent qu'une seule ligne.

### 3.2 Lire les plaintes

Il n'existe **pas encore de route HTTP** pour les lister. La plateforme lit la
table directement, comme elle le fait déjà pour `center_audio` et
`center_music`. Une requête type :

```sql
SELECT vc."idComplaint",
       vc."created_at",
       vc."duree_ms",
       vc."statut",
       mf.url        AS url_audio,
       mf."mimeType" AS type_audio,
       u."alanyaPhone" AS numero_appelant
FROM voice_complaint vc
JOIN media_files mf ON mf.id = vc."media_id"
LEFT JOIN users u   ON u."alanyaID" = vc."user_id"
WHERE vc."center_alanyaID" = $1
ORDER BY vc."created_at" DESC;
```

> ⚠️ `media_files.url` est **protégée par un jeton** : elle n'est pas lisible
> directement depuis un navigateur sans authentification. Dites-nous si vous
> avez besoin d'un accès et nous ouvrirons une route dédiée — c'est une demi-
> journée, et cela évite de contourner l'authentification.

Le passage du `statut` à `1`, `2` ou `3` est à votre main : rien côté Alanya ne
le modifie après la création.

---

## 4. Le contrat API (côté mobile Alanya)

Pour information — vous n'avez rien à appeler.

```
POST /api/complaints
{
  "centerId": "<uuid du centre vocal>",
  "mediaId":  "<uuid d'un media deja televerse>",
  "cleEnvoi": "<cle d'idempotence, 8 a 64 caracteres>",
  "dureeMs":  42000
}
```

- `201` — plainte créée.
- `200` — **même `cleEnvoi` déjà reçue** : la plainte existante est renvoyée,
  ce n'est pas une erreur.
- `404` — centre ou média introuvable.
- `400` — le numéro visé n'est pas un centre vocal.
- `403` — le média n'appartient pas à l'appelant.

---

## 5. Ce qui n'est pas fait

- **L'enregistrement des conversations agent ↔ client.** Seul le drapeau de
  configuration existe (§1.2). Capturer un appel demande de mélanger deux flux
  WebRTC, de les encoder et de les stocker — et surtout de gérer le
  **consentement de l'appelant**, qui est une obligation légale dans la plupart
  des pays. À traiter comme un chantier à part.
- **Aucune route de lecture des plaintes** (§3.2).
- **Aucune purge automatique.** Les fichiers audio s'accumulent. À prévoir quand
  le volume sera connu.
- **Rien n'est encore testé sur appareil réel.**

---

## 6. Questions ouvertes

1. **Qui traite les plaintes, et où ?** Nous n'avons pas d'écran côté Alanya.
   Est-ce la plateforme qui les affichera ?
2. **Faut-il notifier quelqu'un à l'arrivée d'une plainte ?** Aujourd'hui elle
   est déposée en silence.
3. **Combien de temps les conserver ?** La réponse conditionne la purge.
