#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"

command -v docker >/dev/null
command -v openssl >/dev/null
docker compose version >/dev/null
docker info --format '{{.ServerVersion}}' >/dev/null

# Each run owns its containers, network, and MongoDB volume. No host ports are
# published, and the CI override excludes the application's local .env file.
project_name="worksphere-ci-$$-${RANDOM}-${RANDOM}"
WORKSPHERE_CI_JWT_ACCESS_SECRET="$(openssl rand -hex 48)"
export WORKSPHERE_CI_JWT_ACCESS_SECRET

compose=(
  docker compose --ansi never
  --project-name "$project_name"
  --file "$repo_root/docker-compose.yml"
  --file "$repo_root/docker-compose.ci.yml"
)

cleanup() {
  local status=$?
  trap - EXIT INT TERM

  if (( status != 0 )); then
    "${compose[@]}" ps --all || true
    "${compose[@]}" logs --no-color --tail 200 || true
  fi

  if ! "${compose[@]}" down --volumes --remove-orphans --timeout 10; then
    printf 'Failed to clean up container verification project %s\n' "$project_name" >&2
    if (( status == 0 )); then status=1; fi
  fi
  unset WORKSPHERE_CI_JWT_ACCESS_SECRET
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf 'Verifying containers in isolated project %s\n' "$project_name"
"${compose[@]}" config --quiet
"${compose[@]}" build --pull
"${compose[@]}" up --detach --wait --wait-timeout 180 --no-build

node_version="$(tr -d '[:space:]' < "$repo_root/.nvmrc")"
"${compose[@]}" exec -T api node --input-type=module - "$node_version" \
  < "$script_dir/container-smoke.mjs"

printf 'Container verification passed.\n'
