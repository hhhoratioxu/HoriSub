#!/bin/sh
cd "$(dirname "$0")" || exit 1
exec ./engine/runtime/node ./installer.mjs repair "$@"
