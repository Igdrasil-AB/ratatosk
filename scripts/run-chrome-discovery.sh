#!/usr/bin/env bash
set -euo pipefail

TEST_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/ratatosk-chrome-discovery-XXXXXX")
cleanup() {
  case "$TEST_DIRECTORY" in
    "${TMPDIR:-/tmp}"/ratatosk-chrome-discovery-*) rm -rf -- "$TEST_DIRECTORY" ;;
    *) printf 'Refusing to clean unexpected test directory: %s\n' "$TEST_DIRECTORY" >&2 ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

RATATOSK_CHROME_TEST_DIRECTORY="$TEST_DIRECTORY" \
  node --import tsx scripts/test-chrome-discovery.ts "$@"
