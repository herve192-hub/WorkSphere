#!/usr/bin/env bash
set -euo pipefail

# Invoked only inside verify-containers.sh's disposable MongoDB instance.
test "$(id -u)" -gt 0
test "$(stat -c %u /proc/1)" -gt 0
worksphere_patched_go_pattern='go1[.]26[.]10([[:space:];)]|$)'
for tool in bsondump mongodump mongoexport mongofiles mongoimport mongorestore mongostat mongotop gosu; do
  worksphere_tool_version="$("$tool" --version)"
  # Verify the shipped binaries, not just the builder tag: each embeds the Go
  # stdlib and must carry the crypto/x509 fix for CVE-2026-111943.
  if [[ ! "$worksphere_tool_version" =~ $worksphere_patched_go_pattern ]]; then
    printf '%s must be built with patched Go 1.26.10.\n' "$tool" >&2
    exit 1
  fi
done

# Exercise the parser used by the upstream entrypoint for mongod YAML configs.
mongosh --quiet --nodb --eval 'load("/js-yaml.js"); if (jsyaml.safeLoad("net: {port: 27017}").net.port !== 27017) throw new Error("YAML configuration parsing failed");'

worksphere_backup_dir="$(mktemp -d)"
trap 'rm -rf "$worksphere_backup_dir"' EXIT
mongosh --quiet --eval 'db.getSiblingDB("worksphere_ci_backup").checks.insertOne({ _id: "roundtrip", value: "synthetic CI fixture" });' >/dev/null
mongodump --quiet --db worksphere_ci_backup --archive="$worksphere_backup_dir/check.archive"
mongorestore --quiet --archive="$worksphere_backup_dir/check.archive" \
  --nsFrom='worksphere_ci_backup.*' --nsTo='worksphere_ci_restored.*'
mongosh --quiet --eval 'if (db.getSiblingDB("worksphere_ci_restored").checks.findOne({ _id: "roundtrip" })?.value !== "synthetic CI fixture") throw new Error("Database backup/restore did not preserve the fixture");'
printf 'Verified non-root MongoDB, YAML configuration parsing, tools, and backup/restore round trip.\n'
