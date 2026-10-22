#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
# Match the locked @playwright/test release. The official image includes all
# browser binaries and OS libraries, avoiding per-job apt installs on CI mirrors.
playwright_version="1.64.0"
playwright_image="mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f"

if [[ "${1:-}" == "--prepare" && $# == 1 ]]; then
  # CI gives this network-only preparation its own timeout before stack startup.
  exec docker pull "$playwright_image"
fi
if (( $# != 0 )); then
  printf 'Usage: bash %s [--prepare]\n' "$0" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" || ! -S /var/run/docker.sock ]]; then
  printf 'The container browser runner requires Linux and a local Docker socket.\n' >&2
  exit 1
fi
case "${WORKSPHERE_E2E_BROWSER:-chromium}" in
  chromium|firefox|webkit) ;;
  *) printf 'Choose chromium, firefox, or webkit for WORKSPHERE_E2E_BROWSER.\n' >&2; exit 2 ;;
esac

expected_node="$(tr -d '[:space:]' < "$repo_root/.nvmrc")"
if [[ "$(node --print 'process.versions.node')" != "$expected_node" ]]; then
  printf 'Use Node.js %s before running the container browser tests.\n' "$expected_node" >&2
  exit 1
fi
installed_playwright="$(node --print 'require(process.argv[1]).version' "$repo_root/frontend/node_modules/@playwright/test/package.json")"
if [[ "$installed_playwright" != "$playwright_version" ]]; then
  printf 'Update the browser image pin with @playwright/test; expected %s.\n' "$playwright_version" >&2
  exit 1
fi

# Use setup-node's exact runtime rather than the browser image's bundled Node.
# Preserve workspace paths/ownership so reporters write directly to CI artifacts.
node_prefix="$(node --print 'require("node:path").dirname(require("node:path").dirname(process.execPath))')"
docker_binary="$(command -v docker)"
runner_name="worksphere-browser-$$-${RANDOM}-${RANDOM}"
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  docker rm --force "$runner_name" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Host networking reaches the disposable stack's published loopback ports.
# The Docker CLI/socket support its existing worker stop/restart regression; no
# application signing secrets or production credentials are passed as environment variables.
docker run --rm --init --name "$runner_name" --network host --ipc host \
  --user "$(id -u):$(id -g)" --group-add "$(stat -c %g /var/run/docker.sock)" \
  --mount "type=bind,src=$repo_root,dst=$repo_root" \
  --mount "type=bind,src=$node_prefix,dst=/opt/worksphere-node,readonly" \
  --mount "type=bind,src=$docker_binary,dst=/usr/bin/docker,readonly" \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock \
  --workdir "$repo_root/frontend" \
  --env PATH=/opt/worksphere-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --env PLAYWRIGHT_BROWSERS_PATH=/ms-playwright --env CI \
  --env WORKSPHERE_E2E_BASE_URL --env WORKSPHERE_E2E_API_URL --env WORKSPHERE_E2E_BROWSER \
  --env WORKSPHERE_E2E_AUDIT_WORKER \
  "$playwright_image" /opt/worksphere-node/bin/npm run test:e2e:run -- --project="${WORKSPHERE_E2E_BROWSER:-chromium}"
