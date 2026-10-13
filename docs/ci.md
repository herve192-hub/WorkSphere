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
| Backend unit | Payload/query validation and error handling; no database | `cd backend && npm run test:unit` |
| Backend integration | Auth, employee and audit APIs, MongoDB persistence/transactions, migrations, numbering, hierarchy, security controls, and OpenAPI contracts | `cd backend && npm run test:integration` |
| Frontend unit/component | API adapters, auth state/forms, employee directory, and audit history using Jest/Testing Library | `cd frontend && CI=true npm test -- --watchAll=false --runInBand --coverage` |
| Production build | React compilation and ESLint warnings as errors | `cd frontend && CI=true npm run build` |
| Production container smoke | Readiness, built assets, SPA routes, protected endpoints, and production CSP | `bash .github/scripts/verify-containers.sh` |
| Browser end-to-end/regression | Real frontend/API/MongoDB in separate Chromium, Firefox, and WebKit jobs | `cd frontend && npm run test:e2e` |

Backend test commands discover every top-level `tests/*.test.js` file. The two
pure unit files are explicitly classified; other files, including newly added
tests, default to integration. Tests are partitioned rather than running the same
suite repeatedly under different labels. `npm test` still runs the full backend
suite for local use.

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

Backend jobs upload JUnit and LCOV reports. Frontend jobs upload Jest JSON and
coverage reports. Playwright uploads HTML/JUnit reports and failure traces,
screenshots, and videos. Reports are retained for 14 days, including failed runs.
Coverage is recorded; no arbitrary coverage target has been added.

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
(the [stable release](https://nginx.org/en/download.html)), and MongoDB `7.0.43`
also have immutable image digests. The MongoDB security job reads the image from
Compose so it scans the same version that the application deploys.

Direct npm dependencies use exact versions from the existing tested lockfiles.
Both projects set `save-exact=true` so future installs preserve this policy.
Use `npm ci` and `npx --no-install` for project tools. External Actions retain
their full commit hashes and exact release annotations; scanner versions and
checksums stay in `.github/security/tools.json`. Update pins through reviewed
changes, including security fixes. The repository instructions in `AGENTS.md`
record this policy for future work.

GitHub maintains the software on hosted runners within each OS release;
`ubuntu-24.04` fixes the OS selection, not every preinstalled utility version.

## Existing security findings

The security gates deliberately report pre-existing findings. The current npm
audit reports advisories in the React Scripts build/test toolchain and the
`proxy-addr` dependency. Resolve those findings through reviewed updates; do not
disable scanning or force an audit fix that replaces React Scripts with `0.0.0`.
These automated scans complement the auth/authorization/CSRF regression tests;
they do not replace a manual security review or authenticated penetration test.

Local validation also detected advisories in the built runtime images and the
frontend Dockerfile's missing non-root user. Those are application/image
remediation items; the new security gates report and block them without adding
blanket exceptions.

## Require checks before merging

In GitHub branch protection or a ruleset, make **Required CI checks** a required
status check. It succeeds only when all four called workflows succeed. A failed,
cancelled, or skipped dependency fails the combined gate. This repository change
defines the gate; branch protection is a separate GitHub setting.

No production credentials or deployment are required for these workflows. The
security scans are blocking, so discovering an existing vulnerability can cause
CI to fail even when every application test passes.

References: [Playwright CI](https://playwright.dev/docs/ci),
[CodeQL setup](https://docs.github.com/en/code-security/code-scanning/creating-an-advanced-setup-for-code-scanning/configuring-an-advanced-setup-for-code-scanning),
[Trivy 0.75.0](https://github.com/aquasecurity/trivy/tree/v0.75.0/docs), and
[Gitleaks](https://github.com/gitleaks/gitleaks).
