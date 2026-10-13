#!/bin/sh
set -eu

cd "$(dirname "$0")"

for file in fullchain.pem privkey.pem; do
    if [ ! -r "letsencrypt/live/36.249.184.200/$file" ]; then
        echo "Missing readable letsencrypt/live/36.249.184.200/$file" >&2
        exit 1
    fi
done

if [ ! -f .env ]; then
    umask 077
    key=$(openssl rand -hex 32)
    printf 'ORCA_RELAY_ASSIGNMENT_SIGNING_KEY=%s\n' "$key" > .env
    unset key
fi

docker compose config --quiet
docker compose build relay
docker compose up -d --wait
