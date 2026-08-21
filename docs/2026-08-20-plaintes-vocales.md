# Plaintes vocales et enregistrement des appels

**Statut : livré côté serveur et mobile, en attente de configuration et de test sur appareil.**
**Date : 20/08/2026.**

Deux fonctions livrées ensemble, sur le même socle :

1. **Plaintes vocales.** Un appelant qui joint un **centre vocal**
   (`users.type_compte = 4`) peut taper **0** pour dicter une réclamation. Un
   signal sonore l'y invite, il parle, peut se réécouter, puis envoie.
2. **Enregistrement des conversations.** Un agent dont l'autorisation est posée
   voit ses appels avec un client enregistrés automatiquement.

Ce document décrit **ce que vous avez à configurer** et **le format des données**,
pour que la plateforme puisse régler les centres et afficher ce qui remonte.

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

**Elle est désormais exploitée.** Dès qu'un agent autorisé décroche, sa
conversation est enregistrée et déposée à la fin de l'appel — voir §3.3.

> ⚠️ **Aucune annonce n'est faite au correspondant.** Ni tonalité, ni message,
> ni indicateur de son côté. C'est une décision explicite du propriétaire du
> produit. Dans la plupart des pays, enregistrer sans informer expose
> l'**entreprise qui exploite le centre** : à vous d'en tenir compte dans vos
> conditions d'utilisation.

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

### 3.2 Lire les plaintes, et les écouter

La plateforme lit la table **directement**, comme elle le fait déjà pour
`center_audio` et `center_music`. La colonne **`url_audio`** contient une
**adresse absolue, prête à l'emploi et lisible sans authentification** : il n'y
a rien à intégrer chez vous, ni jeton ni en-tête.

```sql
SELECT vc."idComplaint",
       vc."created_at",
       vc."duree_ms",
       vc."statut",
       vc."url_audio",          -- ← à ouvrir ou à mettre dans un <audio src="…">
       u."alanyaPhone" AS numero_appelant
FROM voice_complaint vc
LEFT JOIN users u ON u."alanyaID" = vc."user_id"
WHERE vc."center_alanyaID" = $1
ORDER BY vc."created_at" DESC;
```

L'adresse a la forme :

```text
https://alanyavox.com/api/public/plaintes/<idComplaint>/audio
```

Elle est servie avec le bon type MIME, en `inline` — un `<audio>` la joue
directement — et avec `Access-Control-Allow-Origin: *`, donc utilisable depuis
votre domaine.

> ⚠️ **CETTE URL N'EST PAS UN CONTRÔLE D'ACCÈS.** Quiconque la connaît écoute la
> plainte. Sa seule protection est d'être **indevinable** : elle porte l'UUID de
> la plainte, tiré au hasard. C'est le compromis habituel pour du média, mais
> ce n'est pas une autorisation — ne la publiez pas, et ne la mettez pas dans
> une page indexable.

> **Pourquoi pas `media_files.url` ?** Elle est protégée par un jeton, et
> l'exposer ouvrirait un second chemin vers **tous** les médias du produit —
> photos, vocaux, documents. La route ci-dessus ne sait servir qu'une ligne de
> `voice_complaint`, et rien d'autre.

Le passage du `statut` à `1`, `2` ou `3` est à votre main : rien côté Alanya ne
le modifie après la création.

### 3.3 Table `call_recording` — les conversations enregistrées

| Colonne | Type | Nul | Description |
| --- | --- | --- | --- |
| `idRecording` | `uuid` | non | Clé primaire |
| `idCompany` | `integer` | non | Entreprise du centre |
| `call_id` | `uuid` | oui | → `calls.id`, `NULL` si l'appel a été purgé |
| `agent_alanyaID` | `uuid` | oui | L'agent enregistré |
| `client_alanyaID` | `uuid` | oui | Le correspondant |
| `media_agent_id` | `uuid` | non | Piste brute : la voix de l'agent |
| `media_client_id` | `uuid` | non | Piste brute : la voix du client |
| `media_mix_id` | `uuid` | **oui** | Le fichier **mélangé** — le seul à écouter |
| `duree_ms` | `integer` | non | Durée de l'appel |
| `statut` | `smallint` | non | `0` à mélanger · `1` en cours · `2` **prêt** · `3` échec |
| `cle_envoi` | `varchar(64)` | non | Clé d'idempotence, unique |
| `url_audio` | `varchar(500)` | **oui** | **Adresse absolue du mélange, à écouter directement** |
| `created_at` | `timestamptz` | non | |

**Pourquoi trois fichiers.** Le composant WebRTC du mobile ne sait enregistrer
qu'**un côté à la fois** : le téléphone envoie donc deux pistes séparées, et le
serveur les mélange avec `ffmpeg`. Le fichier à écouter est **`media_mix_id`**.

> ⚠️ **N'écoutez que les enregistrements en `statut = 2`.** Avant, le mélange
> n'a pas eu lieu et `media_mix_id` est nul. Les deux pistes brutes sont
> conservées **exprès** : elles permettent de refaire le mélange, elles ne sont
> pas destinées à l'écoute — chacune ne contient qu'une seule voix.

**`url_audio` : l'adresse à ouvrir.** Depuis le 21/08/2026, un enregistrement
mélangé porte une **adresse absolue, prête à l'emploi et lisible sans
authentification** — exactement comme une plainte. Rien à intégrer chez vous.

```sql
SELECT cr."idRecording",
       cr."created_at",
       cr."duree_ms",
       cr."url_audio",           -- ← à ouvrir ou à mettre dans un <audio src="…">
       agent."alanyaPhone"  AS numero_agent,
       client."alanyaPhone" AS numero_client
FROM call_recording cr
LEFT JOIN users agent  ON agent."alanyaID"  = cr."agent_alanyaID"
LEFT JOIN users client ON client."alanyaID" = cr."client_alanyaID"
WHERE cr."idCompany" = $1
  AND cr."statut" = 2
ORDER BY cr."created_at" DESC;
```

L'adresse a la forme :

```text
https://alanyavox.com/api/public/enregistrements/<idRecording>/audio
```

Servie avec le bon type MIME, en `inline`, et avec
`Access-Control-Allow-Origin: *`.

> ✅ **`url_audio` non nulle ⇒ écoutable.** Elle est écrite par la **même**
> requête que `statut = 2` : vous n'avez pas à tester les deux. Tant que le
> mélange n'a pas abouti, la colonne est nulle et il n'y a rien à écouter.

> ⚠️ **CETTE URL N'EST PAS UN CONTRÔLE D'ACCÈS, et l'enjeu dépasse celui d'une
> plainte.** Une plainte est dictée par son auteur ; ici c'est une
> **conversation entière, à deux voix**, dont le correspondant n'a pas été
> averti. Quiconque connaît l'adresse l'écoute — sa seule protection est d'être
> **indevinable** (elle porte l'UUID de l'enregistrement). Ne la publiez pas, ne
> la mettez pas dans une page indexable, et ne la transmettez qu'à des personnes
> autorisées à entendre l'appel.

Les **pistes brutes n'ont pas d'adresse publique**, et n'en auront pas : chacune
ne contient qu'une seule voix.

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

- ~~Aucune URL publique pour les enregistrements d'appels~~ — **livrée le
  21/08/2026**, voir §3.3.
- **Aucune purge automatique.** Les fichiers audio s'accumulent, et un
  enregistrement d'appel en garde **trois** — les deux pistes brutes plus le
  mélange. À prévoir dès que le volume sera connu ; c'est la question 3 ci-dessous.
- **Aucun écran côté Alanya** pour consulter les plaintes ou les enregistrements.
- **Rien n'est encore testé sur appareil réel.** En particulier : la capture de
  la voix du correspondant, et la qualité du mélange — les deux pistes étant
  démarrées l'une après l'autre, un décalage audible reste possible.

---

## 6. Questions ouvertes

1. **Qui traite les plaintes, et où ?** Nous n'avons pas d'écran côté Alanya.
   Est-ce la plateforme qui les affichera ?
2. **Faut-il notifier quelqu'un à l'arrivée d'une plainte ?** Aujourd'hui elle
   est déposée en silence.
3. **Combien de temps conserver les audios ?** La réponse conditionne la purge,
   qui n'existe pas. Un enregistrement d'appel occupe **trois fichiers**, et le
   volume grandira bien plus vite que celui des plaintes.
4. ~~Voulez-vous une URL publique pour les enregistrements d'appels ?~~
   **Tranchée le 21/08/2026 : oui, elle est ouverte** (§3.3). Nous la
   redisons ici parce qu'elle vous engage : une conversation entière est
   désormais joignable par une adresse non authentifiée. Si vous préférez
   qu'elle passe par un jeton, ou qu'elle expire, dites-le — le changement est
   de notre côté et ne casse pas votre lecture de la table.
