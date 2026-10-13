# Version policy

- Always use specific stable releases. Never introduce `latest`, prereleases, or floating major/minor tags for dependencies, tools, containers, or CI runners.
- Pin direct npm dependencies to exact versions and keep their lockfiles in sync. Use `npm ci` for reproducible installs and `npx --no-install` for project tools.
- Pin Docker images to an explicit release/OS variant plus an immutable SHA-256 digest. Pin external GitHub Actions to full commit hashes with the exact release version in a comment.
- Verify releases and hashes from official sources before changing them. Update version pins and hashes together through reviewed changes.
- Compatibility ranges in `engines` and upstream dependency metadata in lockfiles describe supported versions; they are not installation pins.

# Repository files

- Commit source, tests, public assets, documentation, and shared configuration. Keep real environment files, credentials, private keys, employee exports, database backups, generated reports/builds, and local editor/tool state out of Git.
- Only `backend/.env.example` and `frontend/.env.example` are shared environment templates; keep their values limited to placeholders and local URLs.
- Shared project `.npmrc` files contain only `save-exact=true`. Registry authentication belongs in untracked local/user configuration.
- Before committing, inspect staged filenames and run `node .github/scripts/check-repository-files.mjs`. Never force-add ignored files to bypass this policy.
