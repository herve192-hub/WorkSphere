/**
 * Validates the generated OpenAPI document against the OpenAPI specification.
 *
 * This script is intended to be run in CI or pre-commit checks to ensure the
 * browser and private Audit contracts remain valid before deployment.
 */
const parser = require("@apidevtools/swagger-parser");
const documents = [require("../src/docs/openapi"), require("../src/audit-service/openapi")];

// Keep private service contracts under the same required CI gate as browser APIs.
Promise.all(documents.map(async (document) => {
  await parser.validate(structuredClone(document), { resolve: { external: false } });
  console.log(`Validated ${document.info.title} OpenAPI ${document.openapi} contract.`);
}))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
