#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1-}" = "--self-check" ]; then
  exec "$root/runtime/node" "$root/native/host.mjs" --self-check
fi
exec "$root/runtime/node" "$root/native/host.mjs"
