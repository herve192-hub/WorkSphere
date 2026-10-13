/**
 * Validates the generated OpenAPI document against the OpenAPI specification.
 *
 * This script is intended to be run in CI or pre-commit checks to ensure the
 * contract stored in src/docs/openapi remains valid before deployment.
 */
const parser = require("@apidevtools/swagger-parser");
const openApiDocument = require("../src/docs/openapi");

parser.validate(structuredClone(openApiDocument), { resolve: { external: false } })
  .then(() => console.log(`Validated ${openApiDocument.info.title} OpenAPI ${openApiDocument.openapi} contract.`))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
