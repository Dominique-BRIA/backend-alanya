#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NOTRE MOTEUR DE RECHERCHE, POUR L'ASSISTANT ALANYA (14/11/2026).
#
# Installe SearXNG — un métamoteur libre qui interroge plusieurs moteurs
# publics et regroupe leurs résultats — sur le VPS, pour `src/lib/web/recherche.ts`.
# Aucune clé, aucun quota.
#
#   sudo bash scripts/installer-searxng.sh
#
# Rejouable : une seconde exécution met le moteur à jour et garde sa
# configuration (et sa clé secrète).
#
# 🔴 IL N'ÉCOUTE QUE SUR LA MACHINE (127.0.0.1:8888). Il n'est jamais exposé :
# seul notre serveur l'interroge. Ne pas changer `bind_address`, ni ouvrir le
# port dans le pare-feu.
#
# ⚠️ LE SERVEUR LE TROUVE PAR `ASSISTANT_MOTEUR_RECHERCHE` (par défaut
# http://127.0.0.1:8888). Moteur arrêté : l'assistant répond sans chercher, il
# ne tombe pas en panne.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RACINE=/opt/searxng
SOURCES=$RACINE/sources
PYTHON=$RACINE/python
REGLAGES=/etc/searxng/settings.yml
PORT=8888

if [ "$(id -u)" -ne 0 ]; then
  echo "À lancer avec sudo." >&2
  exit 2
fi

echo "== Paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git python3-venv python3-dev build-essential \
  libxslt1-dev zlib1g-dev libffi-dev libssl-dev >/dev/null

echo "== Compte dédié, sans connexion"
id searxng >/dev/null 2>&1 || useradd --system --home-dir "$RACINE" --shell /usr/sbin/nologin searxng
mkdir -p "$RACINE"
chown searxng:searxng "$RACINE"

echo "== Sources"
if [ -d "$SOURCES/.git" ]; then
  sudo -u searxng git -C "$SOURCES" pull -q --ff-only
else
  sudo -u searxng git clone -q --depth 1 https://github.com/searxng/searxng "$SOURCES"
fi

echo "== Environnement Python"
[ -x "$PYTHON/bin/python" ] || sudo -u searxng python3 -m venv "$PYTHON"
sudo -u searxng "$PYTHON/bin/pip" install -q -U pip setuptools wheel
sudo -u searxng "$PYTHON/bin/pip" install -q -r "$SOURCES/requirements.txt"
sudo -u searxng sh -c "cd '$SOURCES' && '$PYTHON/bin/pip' install -q --no-build-isolation -e ."
sudo -u searxng "$PYTHON/bin/pip" install -q granian

echo "== Réglages"
mkdir -p /etc/searxng
if [ ! -f "$REGLAGES" ]; then
  # La clé secrète n'est tirée qu'à la première installation : la régénérer à
  # chaque mise à jour n'apporterait rien et invaliderait les jetons du moteur.
  cat >"$REGLAGES" <<EOF
# Moteur de recherche de l'Assistant Alanya — voir scripts/installer-searxng.sh.
use_default_settings: true

general:
  instance_name: "Alanya"
  enable_metrics: false

search:
  safe_search: 1
  default_lang: "fr"
  autocomplete: ""
  # Le JSON est le format que lit notre serveur.
  formats:
    - html
    - json

server:
  bind_address: "127.0.0.1"
  port: $PORT
  secret_key: "$(openssl rand -hex 32)"
  # Un seul client, notre serveur : la limitation par adresse n'a pas d'objet.
  limiter: false
  public_instance: false
  image_proxy: false

outgoing:
  # Une réponse lente fait attendre l'utilisateur : on abandonne un moteur
  # public au bout de 4 s, les autres répondent.
  request_timeout: 4.0
  max_request_timeout: 8.0
EOF
fi
chown -R root:searxng /etc/searxng
chmod 0750 /etc/searxng
chmod 0640 "$REGLAGES"

echo "== Service"
cat >/etc/systemd/system/searxng.service <<EOF
[Unit]
Description=SearXNG, moteur de recherche de l'Assistant Alanya (127.0.0.1:$PORT)
After=network-online.target
Wants=network-online.target

[Service]
User=searxng
Group=searxng
Environment=SEARXNG_SETTINGS_PATH=$REGLAGES
WorkingDirectory=$SOURCES
ExecStart=$PYTHON/bin/granian --interface wsgi --host 127.0.0.1 --port $PORT --workers 2 searx.webapp:app
Restart=always
RestartSec=5
# Bornes : il partage la machine avec l'API, la base et le temps réel.
MemoryMax=600M
CPUQuota=150%
# Durcissement : il lit ses sources et ses réglages, n'écrit nulle part.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q searxng
systemctl restart searxng

echo "== Contrôle"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
if curl -fsS "http://127.0.0.1:$PORT/search?q=Douala&format=json" -o /tmp/searxng-essai.json; then
  echo "  moteur : en service sur 127.0.0.1:$PORT"
  python3 -c "import json;d=json.load(open('/tmp/searxng-essai.json'));print('  essai « Douala » :', len(d.get('results',[])), 'résultat(s)')"
else
  echo "  moteur : ne répond pas — voir « journalctl -u searxng -n 50 »" >&2
  exit 1
fi
