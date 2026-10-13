#!/bin/sh
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p private-ca letsencrypt/live/36.249.184.200
if [ ! -f private-ca/ca.key ]; then
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -keyout private-ca/ca.key -out private-ca/ca.crt \
    -subj '/CN=Orca Ugreen Private CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign'
fi
certdir=letsencrypt/live/36.249.184.200
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$certdir/privkey.pem" -out private-ca/relay.csr \
  -subj '/CN=36.249.184.200'
cat > private-ca/relay.ext <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:36.249.184.200
EXT
openssl x509 -req -in private-ca/relay.csr \
  -CA private-ca/ca.crt -CAkey private-ca/ca.key -CAcreateserial \
  -days 180 -sha256 -extfile private-ca/relay.ext -out "$certdir/cert.pem"
cat "$certdir/cert.pem" private-ca/ca.crt > "$certdir/fullchain.pem"
openssl verify -CAfile private-ca/ca.crt "$certdir/cert.pem"
