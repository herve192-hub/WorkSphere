# WorkSphere web

React UI with feature folders for authentication, dashboard, employee management,
and read-only audit history for administrators and HR managers.

See the root README for setup, API configuration, and role provisioning.

```sh
npm ci
cp .env.example .env
npm start
```

`REACT_APP_API_URL` must include `/api/v1`. Tokens are HttpOnly cookies; credentials are never saved in browser storage.

Playwright browser tests run against an isolated Docker stack, including the real
API and MongoDB. From this directory:

```sh
npx --no-install playwright install --with-deps chromium
npm run test:e2e
npm run test:e2e:report
```

See [end-to-end tests](../README.md#end-to-end) for workflow coverage, test ports,
role fixtures, and GitHub Actions reports.

CI runs isolated Chromium, Firefox, and WebKit jobs, including the tagged
regression suite. Local runs default to Chromium; use
`WORKSPHERE_E2E_BROWSER=firefox npm run test:e2e` (or `webkit`) after installing
that browser. See the [CI guide](../docs/ci.md) for reports and security gates.
