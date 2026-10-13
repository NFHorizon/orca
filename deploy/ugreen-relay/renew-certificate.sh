#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker run --rm \
  -v "$PWD/letsencrypt:/etc/letsencrypt" \
  -v "$PWD/certbot-work:/var/lib/letsencrypt" \
  -v "$PWD/certbot-logs:/var/log/letsencrypt" \
  -v "$PWD/acme-webroot:/var/www/acme" \
  certbot/certbot:v5.4.0 renew --non-interactive --no-random-sleep-on-renew
docker compose exec -T tls nginx -s reload
