#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"

browser_tests=false
if [[ "${1:-}" == "--browser-tests" ]]; then
  browser_tests=true
  shift
fi
if (( $# != 0 )); then
  printf 'Usage: bash %s [--browser-tests]\n' "$0" >&2
  exit 2
fi

command -v docker >/dev/null
command -v openssl >/dev/null
docker compose version >/dev/null
docker info --format '{{.ServerVersion}}' >/dev/null

# Each run owns its containers, network, and MongoDB volume. The CI override
# excludes the application's local .env file; only browser runs publish ports.
project_name="worksphere-ci-$$-${RANDOM}-${RANDOM}"
WORKSPHERE_CI_JWT_ACCESS_SECRET="$(openssl rand -hex 48)"
export WORKSPHERE_CI_JWT_ACCESS_SECRET

compose=(
  docker compose --ansi never
  --project-name "$project_name"
  --file "$repo_root/docker-compose.yml"
  --file "$repo_root/docker-compose.ci.yml"
)

if [[ "$browser_tests" == true ]]; then
  command -v npm >/dev/null
  compose+=(--file "$repo_root/docker-compose.e2e.yml")
  WORKSPHERE_E2E_BASE_URL="http://localhost:${WORKSPHERE_E2E_WEB_PORT:-3100}"
  WORKSPHERE_E2E_API_URL="http://localhost:${WORKSPHERE_E2E_API_PORT:-5100}/api/v1"
  export WORKSPHERE_E2E_BASE_URL WORKSPHERE_E2E_API_URL
fi

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

if [[ "$browser_tests" == true ]]; then
  "${compose[@]}" exec -T api node - "$(cat "$repo_root/frontend/e2e/fixtures.json")" \
    < "$script_dir/seed-browser.cjs"
  npm --prefix "$repo_root/frontend" run test:e2e:run
  printf 'Browser verification passed.\n'
fi
