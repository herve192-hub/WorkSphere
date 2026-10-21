# CI checks and security gates

The `CI` workflow runs on every pull request and on pushes to `main` or `develop`.
It calls the backend, frontend, container, and security workflows. There are no
path filters, so changes to shared files or documentation cannot leave the
required check pending or accidentally bypass checks. Each child workflow can
also be run manually. Security CI additionally runs every Monday at 05:23 UTC
to catch new advisories without waiting for a code change.

## Tests and reports

| Check | Coverage | Local command |
| --- | --- | --- |
| Backend unit | Payload/query validation, audit event contracts, error handling, and domain import boundaries; no database | `cd backend && npm run test:unit` |
| Backend integration | Auth, employee and audit APIs, MongoDB persistence/transactions, migrations, numbering, hierarchy, transactional outbox storage, security controls, OpenAPI contracts, and two-process concurrency | `cd backend && npm run test:integration` |
| Frontend unit/component | API adapters, auth state/forms, employee directory, and audit history using Vitest/Testing Library | `cd frontend && npm run test:ci` |
| Production build | React compilation and ESLint warnings as errors | `cd frontend && CI=true npm run build` |
| Production container smoke | Non-root MongoDB, YAML parsing, backup/restore round trip, readiness, built assets, SPA routes, protected endpoints, and production CSP | `bash .github/scripts/verify-containers.sh` |
| Browser end-to-end/regression | Real frontend/API/MongoDB in separate Chromium, Firefox, and WebKit jobs | `cd frontend && npm run test:e2e` |

Backend test commands discover every top-level `tests/*.test.js` file. The four
pure unit files are explicitly classified; other files, including newly added
tests, default to integration. Tests are partitioned rather than running the same
suite repeatedly under different labels. `npm test` still runs the full backend
suite for local use.

The two-process integration fixture launches independent API workers against one
disposable replica set. It checks reciprocal manager assignments, concurrent
manager deletion/deactivation, guard rollback, shared authentication rate limits,
and expiration before MongoDB TTL cleanup. These tests must use separate processes
so an in-memory lock or counter cannot accidentally satisfy the assertions.

Outbox contract tests reject sensitive/unexpected fields and invalid envelopes.
The storage tests use two independent MongoDB clients to verify atomic commit and
rollback with a synthetic business write, concurrent per-resource sequences,
session ownership, duplicate IDs, and persistence after reconnecting. They test
the foundation independently of live audit capture, which is a later PR.

The Playwright regression file is tagged `@regression` and checks:

- Immutable generated numbers and no reuse after deletion.
- Missing managers, self-management, reporting cycles, and handling reports
  before deletion or deactivation.
- Escaped employee content and literal search.
- Trusted-Origin enforcement, HttpOnly/SameSite cookie settings, and API
  documentation security headers.

Each browser gets its own disposable Compose project/database and one worker,
which keeps test data and login rate limits isolated. Local runs default to
Chromium; run `WORKSPHERE_E2E_BROWSER=firefox npm run test:e2e` or the corresponding
`webkit` command after installing that browser. CI installs each project's
browser/system dependencies using the locked Playwright package. Generated JWT
keys and seeded accounts belong only to the test stack, which is cleaned up on
success and failure.

Browser coverage also verifies Swagger asset loading in WebKit. The API disables
CSP's HTTPS-upgrade directive for local HTTP development and retains it in
production. Container smoke checks verify that policy in both environments.

Backend jobs upload JUnit and LCOV reports. Frontend jobs upload Vitest JSON,
JUnit, and coverage reports. Playwright uploads HTML/JUnit reports and failure traces,
screenshots, and videos. Reports are retained for 14 days, including failed runs.
Coverage is recorded; no arbitrary coverage target has been added.

The frontend uses Vite for development/production builds and Vitest with jsdom
for unit/component tests. `npm test` runs the frontend suite once;
`npm run test:watch` starts watch mode. `npm run build` first runs ESLint with
zero warnings allowed, including React Hooks dependency checks, then compiles
the app into `frontend/build` for the existing Nginx image. JSX source and tests
use `.jsx`; Vitest collects only `src/**/*.test.{js,jsx}`, keeping Playwright
tests in their separate browser jobs. Test setup installs DOM matchers and
cleans the rendered DOM after every test.

`frontend/index.html` is Vite's entry point; `frontend/public` contains static
assets. The existing `REACT_APP_API_URL` setting still works in local environment
files and as a Docker build argument. Vite defines only this public value in
browser code; it does not expose the entire environment. Development still
listens on port `3000` with `npm start`.

## Security scans

| Scan | Scope | Failure policy |
| --- | --- | --- |
| npm audit | Both complete lockfiles, including test/build dependencies | High/critical advisories or audit/registry errors |
| CodeQL security-extended | Production JavaScript/TypeScript and CI JavaScript helpers | Source security scores of 7 or higher; analysis errors |
| Gitleaks | All reachable Git history with output redacted | Any detected secret or scanner error |
| Repository file policy | Tracked paths against Git ignore rules; environment files and shared npm configuration | Ignored/generated files in Git, real environment files, or npm configuration beyond the exact version policy |
| actionlint | Workflow syntax, expressions, action inputs, and shell steps | Any lint error |
| Trivy configuration | Docker/infrastructure configuration | High/critical misconfigurations or scanner errors |
| Trivy images | Built API/web images and the MongoDB image; OS and application packages | High/critical advisories, including unfixed issues, or scanner errors |

Reports are uploaded even when scans fail. CodeQL publishes results to GitHub's
code scanning view for trusted events. Fork pull requests still run analysis and
the local SARIF gate, but do not attempt an authenticated SARIF upload. CodeQL
works with this public repository; a private repository needs GitHub Code
Security enabled. Scanning jobs receive only the permissions they need, and
checkout does not leave Git credentials available to subsequent commands.

Dependency audits print severity counts, blocking packages, and advisory links
in the job log, then return the original npm audit exit status. The complete
JSON report is still uploaded as `dependency-audit-backend` or
`dependency-audit-frontend`. An audit failure is not a failure to create the
report directory. Registry/command errors and invalid reports also fail the job.

Trivy configuration and image jobs also render their saved JSON reports as
tables in the job log before returning the scanner's original exit status. The
JSON artifacts retain full details; scanner/report errors still block CI.

The workflow uses commit-pinned GitHub Actions. CLI security tools are downloaded
from their official release URLs and verified against the checked-in SHA-256
hashes in `.github/security/tools.json`; no unpinned install script is executed.
Dependabot checks npm, Docker, and GitHub Actions dependencies weekly. Review
tool version/checksum updates together. `.gitleaks.toml` allows only the exact
public fixture values in their specific test files; it does not exempt whole
directories from secret scanning.

The repository file check also catches ignored files that were previously
tracked or force-added; `.gitignore` alone cannot remove them from Git. Only the
two reviewed `.env.example` templates may be tracked, with placeholders and
local URLs. Shared `.npmrc` files may contain only `save-exact=true`; registry
credentials stay in untracked local/user configuration. Environment files,
private keys, cloud credentials, database backups, employee exports/uploads,
generated builds/reports, and editor state are excluded by the ignore rules.

Before committing, run `git diff --cached --name-only` and
`node .github/scripts/check-repository-files.mjs` from the repository root.
The script checks the Git index; stage the intended files before running it.
Use the pinned Gitleaks tool to scan changed content with `--redact=100` as well.
CI rejects violations after a commit; these checks do not install a local hook
or prevent someone from forcing files into Git.

## Stable version pins

All workflows use the explicit `ubuntu-24.04` runner release. Node.js is pinned
to `26.10.0` in `.nvmrc`; the Node Docker build/runtime variants, Nginx `1.30.5`
(the [stable release](https://nginx.org/en/download.html)), and MongoDB `7.0.45`
also have immutable image digests. Compose and the MongoDB security job build
the same patched image from `containers/mongo/Dockerfile`. All image scan jobs
build directly from their Docker contexts, so they need neither local
environment files nor runtime JWT credentials.

Direct npm dependencies use exact versions with committed lockfiles.
Both projects set `save-exact=true` so future installs preserve this policy.
Frontend tooling pins Vite `8.3.4`, React plugin `6.1.2`, Vitest and its V8
coverage provider `5.0.4`, jsdom `30.1.2`, ESLint `10.12.0`, and the React lint
plugin `5.26.5`. Release versions,
integrities, engines, and peer compatibility were checked against the official
npm registry before updating the lockfile.
Use `npm ci` and `npx --no-install` for project tools. External Actions retain
their full commit hashes and exact release annotations; scanner versions and
checksums stay in `.github/security/tools.json`. Update pins through reviewed
changes, including security fixes. The repository instructions in `AGENTS.md`
record this policy for future work.

GitHub maintains the software on hosted runners within each OS release;
`ubuntu-24.04` fixes the OS selection, not every preinstalled utility version.

## Existing security findings

The security gates deliberately report pre-existing findings. The frontend's
React Scripts/Jest/Webpack toolchain brought in high-severity advisories,
including dependencies without patched releases. It has been replaced with
Vite/Vitest, retaining the existing tests and production container contract.
The former frontend overrides are removed with the dependency tree they
patched. The backend still pins `proxy-addr` to `2.0.8` through an exact override
to resolve its [critical advisory](https://github.com/advisories/GHSA-jqcg-44mw-7w3h).
Continue scanning the complete lockfiles, including build/test dependencies;
new advisories must fail CI until reviewed and remediated.
The complete migrated frontend lockfile reported zero vulnerabilities at local
validation; this includes development, lint, build, and test dependencies.
These automated scans complement the auth/authorization/CSRF regression tests;
they do not replace a manual security review or authenticated penetration test.

Runtime image gates scan OS packages and installed application dependencies,
including unfixed advisories. Findings are remediated in the deployed image.
The API installs production
dependencies in a separate Docker build stage and removes npm/npx from the
final Node runtime. This removes the unused package manager's vulnerable
`brace-expansion`, `http-cache-semantics`, and `undici` dependency copies from the
deployed filesystem. Application dependencies and the pinned Node runtime are
still scanned, including unfixed advisories. Container smoke checks also require
the API to run without root and reject images that expose npm/npx commands.
Run operational scripts directly with `node scripts/<script>.js` inside the
API container; install and audit dependencies in local/CI build environments.

The frontend's former `DS-0002` finding
is resolved: Nginx runs as its existing `nginx` user, writes its PID in `/tmp`,
and listens on container port `8080`. Compose port mappings, health checks, and
smoke checks use that port. Container verification also checks that both the
configured runtime user and Nginx master process have non-zero user IDs.

The Nginx runtime also installs exact Alpine 3.24 security package releases:
`libexpat=2.9.0-r0`, `libx11=1.8.14-r0`, `pcre2=10.49-r0`, and
`tiff=4.7.2-r0`. These address `CVE-2026-93990`, `CVE-2026-88806`,
`CVE-2026-103111`, and `CVE-2026-4775` respectively. The
Nginx image tag/digest stays pinned; package versions were verified against its
official Alpine release repositories. Review these pins with future image and
security updates. Full image scanning remains blocking for high/critical
findings, including unfixed advisories.

Alpine's release repositories replace superseded packages. The former
`libexpat=2.8.5-r0` pin disappeared when `2.9.0-r0` was published, causing fresh
GitHub container builds to fail while local builds reused a successful layer.
When reviewing package pin changes, verify availability against the base image's
signed Alpine indexes and build the frontend with `docker build --pull --no-cache
--build-arg CI=true --build-arg REACT_APP_API_URL=http://localhost:5000/api/v1
frontend` before running container/browser checks. Keep versions exact; do not
remove security patches or loosen the scan gate to make a build pass.
The same fresh-image review found the bundled `libx11=1.8.13-r0` vulnerability;
its patched version was confirmed in [Alpine's security database](https://secdb.alpinelinux.org/v3.24/main.json)
and signed release index before updating the exact pin.

MongoDB stays on the 7.0 release line, using the official `7.0.45-jammy` image
as its checksum-pinned base. Its bundled helper components are patched too:
OpenSSL `libssl3=3.0.2-0ubuntu1.30`, compatible `js-yaml 3.15.2`, and `gosu 1.19`
plus database tools `100.19.1` rebuilt with Go `1.26.9`. Database tools also use
`golang.org/x/net v0.60.0`. Source archives and the Go builder have fixed
checksums/digests; module downloads are checked against upstream Go checksums.
The database tools retain the upstream Kerberos build tags. Build dependencies
and source archives stay in the builder stage.

The runtime uses the existing `mongodb` UID/GID `999`, with the upstream
entrypoint, `mongosh`, database tools, replica-set setup, and named volume.
The shell has a writable home at `/home/mongodb` so caches previously created
by root inside an older database volume do not cause permission warnings.
Container verification checks non-root execution, YAML parsing, all tool
executables, and a synthetic dump/restore round trip inside its disposable
database. Existing application data volumes are not used by verification.

## Require checks before merging

In GitHub branch protection or a ruleset, make **Required CI checks** a required
status check. It succeeds only when all four called workflows succeed. A failed,
cancelled, or skipped dependency fails the combined gate. This repository change
defines the gate; branch protection is a separate GitHub setting.

The final gate prints each called workflow's result and writes a summary with
links to the current run's jobs and artifacts. `security: failure` means at least
one security job failed; open that job's first failed step for the scanner error
or finding. A passing build/browser suite does not override a failed audit or
scan. Rerunning an existing GitHub run uses its original commit; local fixes
must be committed and pushed before a new run can include them.

No production credentials or deployment are required for these workflows. The
security scans are blocking, so discovering an existing vulnerability can cause
CI to fail even when every application test passes.

References: [Playwright CI](https://playwright.dev/docs/ci),
[Vite environment settings](https://vite.dev/guide/env-and-mode),
[Vitest migration](https://vitest.dev/guide/migration/),
[CodeQL setup](https://docs.github.com/en/code-security/code-scanning/creating-an-advanced-setup-for-code-scanning/configuring-an-advanced-setup-for-code-scanning),
[Trivy 0.75.0](https://github.com/aquasecurity/trivy/tree/v0.75.0/docs), and
[Gitleaks](https://github.com/gitleaks/gitleaks).
