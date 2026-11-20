#!/bin/sh
cd "$(dirname "$0")" || exit 1
if [ "$#" -eq 0 ]; then
  printf '%s' 'Also delete downloaded HoriSub models? [y/N] '
  IFS= read -r delete_models
  if [ "$delete_models" = y ] || [ "$delete_models" = Y ]; then set -- --purge-models; fi
fi
exec ./engine/runtime/node ./installer.mjs uninstall "$@"
