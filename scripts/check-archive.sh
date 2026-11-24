#!/usr/bin/env bash
# Verify one packaged archive the way CI does: checksum, root directory, and
# the license material that must ship next to the executable.
#
# Usage: check-archive.sh <archive.tar.gz>
#
# The listing is materialised in full before it is inspected. Reading a tar
# stream through `head` closes the pipe early, and under `pipefail` that makes
# tar exit with "stdout: write error" even for a healthy archive. This script
# keeps tar's real exit status and never masks a failure with `|| true`.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: check-archive.sh <archive.tar.gz>" >&2
  exit 2
fi

archive=$1
if [ ! -f "$archive" ]; then
  echo "check-archive: no such archive: $archive" >&2
  exit 2
fi

case "$archive" in
  *.tar.gz) ;;
  *)
    echo "check-archive: expected a .tar.gz archive, got: $archive" >&2
    exit 2
    ;;
esac

archive_dir=$(cd "$(dirname "$archive")" && pwd)
archive_name=$(basename "$archive")
checksum_file="$archive_dir/$archive_name.sha256"
if [ ! -f "$checksum_file" ]; then
  echo "check-archive: missing checksum file: $checksum_file" >&2
  exit 1
fi

# sha256sum -c reads "<hash>  <name>" from the directory holding the archive.
(cd "$archive_dir" && sha256sum -c "$archive_name.sha256")

listing=$(mktemp)
trap 'rm -f "$listing"' EXIT
tar -tzf "$archive" >"$listing"
if [ ! -s "$listing" ]; then
  echo "check-archive: $archive has an empty listing" >&2
  exit 1
fi

root=$(sed -n '1s|/.*||p' "$listing")
if [ -z "$root" ]; then
  echo "check-archive: $archive has no top-level directory" >&2
  exit 1
fi

missing=0
for required in LICENSE THIRD-PARTY-NOTICES.md; do
  if ! grep -qx -- "$root/$required" "$listing"; then
    echo "check-archive: $archive is missing $required at its root ($root/)" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "check-archive: first entries of $root/:" >&2
  sed -n '1,20p' "$listing" >&2
  exit 1
fi

echo "check-archive: $root carries LICENSE and THIRD-PARTY-NOTICES.md"