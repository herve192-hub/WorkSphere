# WorkSphere web

React UI with feature folders for authentication, dashboard, and employee management.

See the root README for setup, API configuration, and role provisioning.

```sh
npm ci
cp .env.example .env
npm start
```

`REACT_APP_API_URL` must include `/api/v1`. Tokens are HttpOnly cookies; credentials are never saved in browser storage.
