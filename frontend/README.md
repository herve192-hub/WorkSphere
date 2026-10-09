# WorkSphere web

React UI with feature folders for authentication, dashboard, and employee management.

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
npx playwright install --with-deps chromium
npm run test:e2e
npm run test:e2e:report
```

See [end-to-end tests](../README.md#end-to-end) for workflow coverage, test ports,
role fixtures, and GitHub Actions reports.
