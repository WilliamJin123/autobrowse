#!/bin/bash
# stop.sh [port] [achieved|failed] [summary]  → `autobrowse stop`: the verdict, then browser and socket closed.
exec "$(cd "$(dirname "$0")/../../../.." && pwd)/bin/autobrowse" stop "$@"
