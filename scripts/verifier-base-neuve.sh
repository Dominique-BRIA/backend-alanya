#!/bin/bash
# UNE BASE NEUVE PEUT-ELLE ÊTRE BÂTIE, ET LE SQL MANUEL EST-IL REJOUABLE ?
#
#   bash scripts/verifier-base-neuve.sh
#
# 🔴 CE QUE CE CONTRÔLE RÉPOND, ET QUE RIEN NE RÉPONDAIT.
#
# Le déploiement rejoue `prisma/manual/*.sql` sur une base qui EXISTE DÉJÀ. Il
# ne dit donc RIEN de la question qui compte le jour d'une restauration ou d'un
# second serveur : peut-on partir de zéro ?
#
# 🐛 La réponse était NON, découverte le 26/09/2026. Deux fichiers échouaient sur
# une base neuve, et comme `apply-manual-sql.sh` s'arrête à la première erreur,
# les VINGT suivants n'étaient jamais posés. Personne ne pouvait le savoir : sur
# la base de production, ces deux fichiers passent.
#
# ⚠️ CE N'EST PAS UNE ÉTAPE DE DÉPLOIEMENT. Il crée et détruit une base : il a sa
# place sur un poste de développement ou dans le CI, jamais dans `deployer.sh`.
#
# 🔴 IL NE TOUCHE JAMAIS LA BASE DE L'APPLICATION. Il refuse de démarrer si le
# nom de la base jetable est celui du `.env` — et le nom porte un horodatage, ce
# qui rend la collision presque impossible avant même ce contrôle.
#
# Deux choses sont vérifiées, et il en faut deux :
#
#   1. LA CONSTRUCTION — `schema.prisma` bâtit la structure, puis les 74
#      compléments passent. C'est le chemin d'une restauration.
#   2. L'IDEMPOTENCE — on rejoue la série une seconde fois, et rien ne casse ni
#      ne se duplique. C'est le chemin de chaque déploiement.

set -euo pipefail
cd "$(dirname "$0")/.."

rouge() { printf "\033[31m%s\033[0m\n" "$1"; }
vert()  { printf "\033[32m%s\033[0m\n" "$1"; }
jaune() { printf "\033[33m%s\033[0m\n" "$1"; }

BASE="alanya_controle_$(date +%Y%m%d%H%M%S)"

# La connexion d'administration. Par défaut la socket locale, qui suffit sur un
# poste de développement ; surchargeable pour un CI.
HOTE_SOCKET="${PG_SOCKET:-/var/run/postgresql}"
URL="postgresql:///${BASE}?host=${HOTE_SOCKET}"

# ⚠️ GARDE-FOU : jamais la base de l'application.
if [ -f .env ]; then
  BASE_APPLI="$(sed -n 's|^DATABASE_URL=.*/\([a-zA-Z0-9_-]*\)["'"'"']*.*$|\1|p' .env | head -1)"
  if [ -n "$BASE_APPLI" ] && [ "$BASE_APPLI" = "$BASE" ]; then
    rouge "✗ Le nom de la base jetable est celui de l'application. Arrêt."
    exit 1
  fi
fi

TEMPORAIRE="$(mktemp -d)"
nettoyer() {
  dropdb --if-exists "$BASE" 2>/dev/null || true
  rm -rf "$TEMPORAIRE"
}
trap nettoyer EXIT

echo
echo "▸ Base jetable : $BASE"
echo

# ── 1. La structure, depuis le schéma ───────────────────────────────────────
echo "▸ 1/3  Structure depuis schema.prisma"
createdb "$BASE" 2>/dev/null || {
  rouge "✗ Impossible de créer une base."
  jaune "  Ce contrôle a besoin du droit CREATEDB sur le PostgreSQL local."
  jaune "  Sur un serveur de production, il n'a pas sa place : lance-le sur ton poste."
  exit 1
}

# ⚠️ `migrate diff` NE SE CONNECTE À RIEN : il lit le schéma et écrit du SQL.
# `db push` aurait lu `DATABASE_URL` du `.env` — donc visé la vraie base.
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > "$TEMPORAIRE/structure.sql"

psql -q "$URL" -v ON_ERROR_STOP=1 -f "$TEMPORAIRE/structure.sql" >/dev/null
vert "  $(grep -c 'CREATE TABLE' "$TEMPORAIRE/structure.sql") tables créées."

# ── 2. Les compléments, sur cette base neuve ────────────────────────────────
rejouer() {
  local passage="$1" total=0 reussis=0 echecs=""
  for fichier in prisma/manual/*.sql; do
    [ -e "$fichier" ] || continue
    total=$((total + 1))
    if psql -q "$URL" -v ON_ERROR_STOP=1 -f "$fichier" >"$TEMPORAIRE/f.log" 2>&1; then
      reussis=$((reussis + 1))
    else
      echecs="$echecs $fichier"
      rouge "  ✗ $fichier"
      grep -iE "ERROR" "$TEMPORAIRE/f.log" | head -2 | sed 's/^/      /'
    fi
  done
  if [ -n "$echecs" ]; then
    rouge "  $reussis / $total — $passage ÉCHOUE."
    return 1
  fi
  vert "  $reussis / $total — $passage."
  return 0
}

echo
echo "▸ 2/3  SQL manuel sur une base neuve (chemin d'une restauration)"
rejouer "construction" || exit 1

echo
echo "▸ 3/3  SQL manuel une seconde fois (chemin de chaque déploiement)"
rejouer "idempotence" || exit 1

# Un contrôle de fond : la ligne globale des plafonds ne doit pas s'être
# dupliquée. C'est le seul INSERT de données de toute la série, donc le seul
# endroit où un second passage pourrait créer du doublon.
DOUBLONS="$(psql -tA "$URL" -c "SELECT count(*) FROM limite_reunion WHERE idcompany IS NULL")"
if [ "$DOUBLONS" != "1" ]; then
  rouge "✗ La ligne globale de limite_reunion est présente $DOUBLONS fois au lieu d'une."
  exit 1
fi

echo
vert "══ Une base neuve se bâtit, et la série se rejoue sans effet. ══"
echo
