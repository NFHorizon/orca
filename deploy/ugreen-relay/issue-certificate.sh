#!/bin/sh
set -eu
cd "$(dirname "$0")"
mkdir -p acme-webroot letsencrypt certbot-work certbot-logs
docker run --rm \
  -v "$PWD/letsencrypt:/etc/letsencrypt" \
  -v "$PWD/certbot-work:/var/lib/letsencrypt" \
  -v "$PWD/certbot-logs:/var/log/letsencrypt" \
  -v "$PWD/acme-webroot:/var/www/acme" \
  certbot/certbot:v5.4.0 certonly \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --preferred-profile shortlived --webroot --webroot-path /var/www/acme \
  --cert-name 36.249.184.200 --ip-address 36.249.184.200 "$@"
