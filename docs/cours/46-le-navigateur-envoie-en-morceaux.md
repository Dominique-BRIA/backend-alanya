# Chapitre 46 — Le navigateur envoie en morceaux

> **Où nous en sommes.** 10/10/2026. Le téléphone envoie en morceaux, fils
> chiffrés et en clair (chapitres 44 et 45). Reste le navigateur. Ce chapitre
> est le plus court de la série : le serveur était prêt, et l'onglet ouvert
> simplifie tout.
>
> Web : `src/services/envoi-morceaux.ts`. Banc :
> `scripts/e2ee-media-morceaux-web.mjs`.

---

## 1. Ce que le navigateur ne sait pas faire, et ce qu'on en déduit

Un navigateur ne continue pas un envoi **page fermée** : il n'a pas
d'Android pour prendre le relais. Conséquence directe, et heureuse : l'onglet
est ouvert jusqu'au dernier octet, donc **le navigateur poste lui-même le
message** une fois le fichier arrivé, comme avant. Pas de préparation à
l'avance, pas de publication différée.

Ce qu'on gagne quand même :

- **la vitesse** : trois morceaux à la fois ; sur une connexion lente ou
  instable, plusieurs connexions vont plus vite qu'une seule ;
- **la reprise** : une coupure ne coûte que le morceau en vol, réessayé seul
  (1, 2, 4, 8 puis 16 secondes d'attente) ;
- **le pourcentage** : « 18 % » à côté de l'horloge de la bulle.

## 2. Une seule fonction pour tout : `televerser`

```ts
televerser(fichier, { nom, mime, chiffre, empreinteHex, onProgression })
  → { id }   // l'identifiant du média
```

- au-delà d'**un mébioctet** : réservation, morceaux, assemblage ;
- en deçà : `POST /api/media`, d'un seul bloc — réserver puis envoyer ferait
  deux requêtes là où une suffit ;
- si le serveur ne connaît pas encore les envois en morceaux (404 à la
  réservation) : d'un seul bloc aussi.

Le chemin chiffré (`envoyerMediaChiffre`) et le chemin en clair de l'écran
de conversation l'appellent tous deux. Pour un fichier chiffré, l'empreinte
du chiffré — déjà calculée pour le descripteur — part aussi au serveur, qui
vérifie l'assemblage.

## 3. `XMLHttpRequest`, et pas `fetch`

`fetch` ne donne **pas** l'avancement d'un envoi : il n'expose que le flux de
la réponse. Seul `XMLHttpRequest` a `upload.onprogress`. Pour afficher
« 18, 20, 23 % » pendant qu'un morceau part, il faut donc lui.

## 4. Les règles reprises du téléphone

- **Pondéré par les octets** : le dernier morceau est plus court.
- **Jamais 100 % avant le serveur** : plafonné à 99 % tant que l'assemblage
  n'a pas répondu.
- **Rafraîchi au changement de pour cent seulement** : un rendu par paquet
  réseau redessinerait tout le fil des centaines de fois.
- **Un refus (4xx) n'est pas réessayé** : un jeton faux ou un envoi expiré ne
  s'arrangeront pas en insistant.
- **Si personne n'a dit « terminé »** — deux morceaux ont fini ensemble et
  c'est l'autre qui a assemblé —, on demande au serveur (`…/terminer`).

## 5. Les preuves, et un défaut qui n'est pas le nôtre

`scripts/e2ee-media-morceaux-web.mjs`, dans un vrai Chrome — **TOUT EST
VERT** (16 ✓) :

- fil chiffré : 2,6 Mo envoyés par l'interface, **trois morceaux**
  assemblés, empreinte vérifiée, message posté par le navigateur sans texte
  en clair, pourcentages vus à l'écran : 38, 61, 99 ; Bob voit le fichier
  sous son vrai nom, déchiffré ;
- fil en clair : trois morceaux, fichier rangé sous son **vrai** nom et son
  vrai type, Bob le voit.

Le banc web plus ancien (`e2ee-media-envoi.mjs`) a été rejoué : 17 ✓ et
**2 ✗**, tous deux sur l'aperçu d'un PDF (nombre de pages, première page).
Avant de conclure, on a **remis le code d'origine** et rejoué : les deux mêmes
échecs. Le défaut est antérieur à ce chantier — à traiter à part.

> **À retenir.** « Ce n'est pas moi » ne se dit pas, ça se montre : on rejoue
> le même banc sur le code d'avant.

## 6. Ce qui reste vrai

- Onglet fermé, l'envoi s'arrête ; rouvert, le fichier repart de zéro (la
  réservation n'est pas gardée dans le navigateur).
- Les statuts, photos de profil et répondeurs gardent `uploadMedia` : petits
  fichiers.
