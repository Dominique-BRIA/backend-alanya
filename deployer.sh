#!/usr/bin/env bash
#
# Déploiement du backend Alanya — API Next.js + serveur WebSocket.
#
# À exécuter SUR LE SERVEUR, depuis le dossier du dépôt :
#     ./deployer.sh
#
# Le script s'arrête à la première erreur. Rien n'est appliqué en base avant
# qu'une sauvegarde ait réussi.
#
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# À VÉRIFIER UNE FOIS, puis plus jamais.
# ─────────────────────────────────────────────────────────────────────────────
BRANCHE="feature/vocal-attente-loop"
DEPOT_SSH="git@github.com:Dominique-BRIA/backend-alanya.git"

# Noms des deux processus chez ton gestionnaire (pm2 ou systemd).
PROC_API="alanya-api"
PROC_WS="alanya-ws"

# Où déposer les sauvegardes de base.
DOSSIER_SAUVEGARDES="$HOME/sauvegardes-alanya"

# Ports d'écoute, pour le contrôle de fin.
PORT_API="${PORT:-3000}"
PORT_WS="${WS_PORT:-3001}"

# ─────────────────────────────────────────────────────────────────────────────

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RACINE"

vert()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
jaune() { printf '\033[0;33m%s\033[0m\n' "$*"; }
rouge() { printf '\033[0;31m%s\033[0m\n' "$*"; }
etape() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }

echec() { rouge "✗ $*"; exit 1; }

# ── 1. Contrôles préalables ─────────────────────────────────────────────────
etape "1/9  Contrôles préalables"

[ -f package.json ] && [ -f ws-server.mjs ] \
  || echec "Ce dossier n'est pas le dépôt backend Alanya."

[ -f .env ] || echec "Aucun fichier .env dans $RACINE."

# Node ≥ 20.9 : Next.js 16 refuse de construire en dessous.
NODE_MAJEUR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINEUR="$(node -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJEUR" -lt 20 ] || { [ "$NODE_MAJEUR" -eq 20 ] && [ "$NODE_MINEUR" -lt 9 ]; }; then
  echec "Node $(node -v) : il faut au moins 20.9 pour Next.js 16."
fi
vert "  Node $(node -v)"

# Un dépôt sali ferait échouer le pull au pire moment.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  rouge "  Modifications locales non validées :"
  git status --short --untracked-files=no
  echec "Valide ou remise ces changements avant de déployer."
fi

# ── 2. LE PIÈGE DU PONT INTERNE ─────────────────────────────────────────────
#
# L'API et le serveur WebSocket sont DEUX PROCESSUS qui se parlent par une
# socket de fichier. Sans elle, l'API écrit en base et personne n'est prévenu :
# une réunion terminée continue de filmer, un exclu continue de parler.
#
# Quand WS_INTERNAL_SOCKET n'est pas posée, chacun retombe sur
# « <son dossier courant>/.ws-interne.sock ». Les deux ne se trouvent donc QUE
# s'ils tournent avec le même dossier courant — ce que rien ne garantit chez un
# gestionnaire de processus. Une valeur explicite supprime la question.
etape "2/9  Pont interne API ↔ WebSocket"

if grep -qE '^\s*WS_INTERNAL_URL\s*=\s*\S' .env; then
  vert "  Mode réseau (WS_INTERNAL_URL posée)."
  grep -qE '^\s*WS_INTERNAL_SECRET\s*=\s*\S' .env \
    || echec "Mode réseau sans WS_INTERNAL_SECRET : le serveur WebSocket refusera de démarrer."
elif grep -qE '^\s*WS_INTERNAL_SOCKET\s*=\s*\S' .env; then
  CHEMIN_SOCKET="$(grep -E '^\s*WS_INTERNAL_SOCKET\s*=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  vert "  Socket de fichier : $CHEMIN_SOCKET"
else
  jaune "  ⚠ WS_INTERNAL_SOCKET n'est PAS posée."
  jaune "    Les deux processus retomberont sur « <dossier courant>/.ws-interne.sock »."
  jaune "    Ils ne se trouveront que s'ils partagent le même dossier courant."
  jaune "    Recommandé — ajoute cette ligne à .env, puis relance :"
  jaune "        WS_INTERNAL_SOCKET=$RACINE/.ws-interne.sock"
  read -r -p "  Continuer quand même ? [o/N] " REPONSE
  [ "${REPONSE:-n}" = "o" ] || echec "Déploiement interrompu."
fi

# ── 3. Récupération du code ─────────────────────────────────────────────────
etape "3/9  Récupération de $BRANCHE"

AVANT="$(git rev-parse HEAD)"
git fetch "$DEPOT_SSH" "$BRANCHE" || echec "Impossible de joindre GitHub."
git checkout "$BRANCHE" 2>/dev/null || git checkout -b "$BRANCHE" FETCH_HEAD
git merge --ff-only FETCH_HEAD || echec "Fusion impossible : la branche locale a divergé."
APRES="$(git rev-parse HEAD)"

if [ "$AVANT" = "$APRES" ]; then
  jaune "  Déjà à jour ($(git log --oneline -1))"
else
  vert "  $(git rev-list --count "$AVANT..$APRES") nouveau(x) commit(s) :"
  git log --oneline "$AVANT..$APRES" | sed 's/^/    /'
fi

# ── 4. Sauvegarde de la base ────────────────────────────────────────────────
#
# AVANT toute migration, et le déploiement s'arrête si elle échoue. Une
# migration ne se défait pas : c'est la seule marche arrière qui existe.
etape "4/9  Sauvegarde de la base"

URL_BASE="$(grep -E '^\s*DATABASE_URL\s*=' .env | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
[ -n "$URL_BASE" ] || echec "DATABASE_URL introuvable dans .env."

mkdir -p "$DOSSIER_SAUVEGARDES"
HORODATAGE="$(date +%Y%m%d-%H%M%S)"
FICHIER_SAUVEGARDE="$DOSSIER_SAUVEGARDES/alanya-$HORODATAGE.sql.gz"

if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$URL_BASE" | gzip > "$FICHIER_SAUVEGARDE" \
    || echec "La sauvegarde a échoué — AUCUNE migration n'a été appliquée."
  vert "  $FICHIER_SAUVEGARDE ($(du -h "$FICHIER_SAUVEGARDE" | cut -f1))"
else
  rouge "  pg_dump absent : impossible de sauvegarder."
  jaune "  Installe-le (« sudo apt install postgresql-client ») ou sauvegarde à la main."
  read -r -p "  Migrer SANS sauvegarde ? [o/N] " REPONSE
  [ "${REPONSE:-n}" = "o" ] || echec "Déploiement interrompu."
fi

# ── 5. Dépendances ──────────────────────────────────────────────────────────
etape "5/9  Dépendances"
npm ci --omit=dev --ignore-scripts || echec "npm ci a échoué."
# `--ignore-scripts` saute le postinstall ; on génère le client juste après,
# explicitement, pour que l'échec éventuel soit lisible.
npx prisma generate || echec "prisma generate a échoué."
vert "  Client Prisma régénéré."

# ── 6. Migrations ───────────────────────────────────────────────────────────
#
# On MONTRE ce qui va s'appliquer avant de l'appliquer.
etape "6/9  Migrations"

npx prisma migrate status || true
echo
read -r -p "  Appliquer les migrations ci-dessus ? [O/n] " REPONSE
if [ "${REPONSE:-o}" = "n" ]; then
  jaune "  Migrations sautées."
else
  npx prisma migrate deploy || echec "prisma migrate deploy a échoué — la base est dans l'état d'avant."
  vert "  Migrations appliquées."
fi

# ── 7. Construction ─────────────────────────────────────────────────────────
#
# AVANT le redémarrage : une construction ratée laisse l'ancienne version en
# ligne, ce qui est très préférable à une coupure.
etape "7/9  Construction"
npm run build || echec "next build a échoué — l'ancienne version tourne toujours."
vert "  Construction terminée."

# ── 8. Redémarrage des DEUX processus ───────────────────────────────────────
etape "8/9  Redémarrage"

if command -v pm2 >/dev/null 2>&1 && pm2 describe "$PROC_API" >/dev/null 2>&1; then
  # `--update-env` : sans lui, pm2 réutilise l'environnement du démarrage
  # d'origine, et une variable ajoutée à .env resterait ignorée.
  pm2 restart "$PROC_API" --update-env || echec "Redémarrage de $PROC_API impossible."
  pm2 restart "$PROC_WS"  --update-env || echec "Redémarrage de $PROC_WS impossible."
  pm2 save >/dev/null 2>&1 || true
  vert "  pm2 : $PROC_API et $PROC_WS redémarrés."
elif systemctl list-units --full --all 2>/dev/null | grep -q "$PROC_API"; then
  sudo systemctl restart "$PROC_API" || echec "Redémarrage de $PROC_API impossible."
  sudo systemctl restart "$PROC_WS"  || echec "Redémarrage de $PROC_WS impossible."
  vert "  systemd : $PROC_API et $PROC_WS redémarrés."
else
  rouge "  Ni pm2 ni systemd ne connaissent « $PROC_API »."
  jaune "  Corrige PROC_API / PROC_WS en tête de ce script, puis redémarre à la main :"
  jaune "      pm2 list        # ou : systemctl list-units | grep alanya"
  exit 1
fi

# nginx ne sert que de façade : il n'a pas besoin de redémarrer pour que le
# code change. On le recharge seulement si sa configuration a bougé.
if command -v nginx >/dev/null 2>&1 && ! sudo nginx -t >/dev/null 2>&1; then
  rouge "  ⚠ La configuration nginx est invalide — NE PAS la recharger en l'état."
fi

# ── 9. Contrôle ─────────────────────────────────────────────────────────────
etape "9/9  Contrôle"

sleep 4
ETAT_API="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_API/api/health" || echo 000)"
case "$ETAT_API" in
  200|204) vert "  API : $ETAT_API" ;;
  404)     jaune "  API : 404 sur /api/health — elle répond, la route n'existe simplement pas." ;;
  000)     rouge "  API : aucune réponse sur le port $PORT_API." ;;
  *)       rouge "  API : $ETAT_API" ;;
esac

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$PORT_WS"; then
  vert "  WebSocket : à l'écoute sur $PORT_WS"
else
  rouge "  WebSocket : rien n'écoute sur $PORT_WS"
fi

echo
vert "══ Déployé : $(git log --oneline -1) ══"
echo
jaune "Si quelque chose cloche :"
echo "    pm2 logs $PROC_API --lines 60      # ou : journalctl -u $PROC_API -n 60"
echo "    pm2 logs $PROC_WS  --lines 60"
echo
jaune "Revenir en arrière (code seulement, PAS les migrations) :"
echo "    git reset --hard $AVANT && npm run build && pm2 restart $PROC_API $PROC_WS"
echo
jaune "Restaurer la base :"
echo "    gunzip -c $FICHIER_SAUVEGARDE | psql \"\$DATABASE_URL\""
