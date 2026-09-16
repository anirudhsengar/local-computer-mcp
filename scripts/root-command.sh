#!/usr/bin/env bash
set -euo pipefail

[[ "$#" == 2 && "$1" == /* ]] || { echo 'usage: root-command ABSOLUTE_CWD COMMAND' >&2; exit 2; }
cd -- "$1"
exec /usr/bin/bash -lc "$2"
