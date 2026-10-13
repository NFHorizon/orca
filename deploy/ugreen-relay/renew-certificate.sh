#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! openssl x509 -checkend 2592000 -noout -in letsencrypt/live/36.249.184.200/cert.pem; then
  ./issue-certificate.sh
  docker compose exec --interactive=false -T tls nginx -s reload
fi
