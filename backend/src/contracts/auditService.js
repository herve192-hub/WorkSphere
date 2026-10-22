// Service tokens are separate from browser access tokens. Both transport ends
// share these claims so producers cannot drift from the private receiver contract.
const ISSUER = "worksphere-internal";
const AUDIENCE = "worksphere-audit";
const MAX_TOKEN_AGE_SECONDS = 60;
const MAX_RETRY_AFTER_MS = 86400000;

module.exports = { ISSUER, AUDIENCE, MAX_TOKEN_AGE_SECONDS, MAX_RETRY_AFTER_MS };
