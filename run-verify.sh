#!/bin/bash
export DATABASE_URL="postgres://norns_runtime:verify@127.0.0.1:54329/norns"
export NORNS_WEB_DIST="$(cd "$(dirname "$0")" && pwd)/apps/web/dist"
export NORNS_HOST=127.0.0.1
export PORT=8790
export NORNS_PUBLIC_ORIGIN="http://127.0.0.1:8790"
cd "$(dirname "$0")"
exec node apps/server/dist/main.js
