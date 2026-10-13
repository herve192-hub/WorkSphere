const assert = require("node:assert/strict");
const parser = require("@apidevtools/swagger-parser");
const Ajv = require("ajv");
const formats = require("ajv-formats");
const document = require("../../src/docs/openapi");
let contract;
const validators = new Map();
const ajv = new Ajv({ strict: false, allErrors: true });
formats(ajv);

async function loadContract() {
  contract ||= await parser.dereference(structuredClone(document), { resolve: { external: false } });
}
function assertResponse(response, path, method) {
  const operation = contract.paths[path]?.[method];
  assert.ok(operation, `Undocumented operation: ${method} ${path}`);
  const documented = operation.responses[response.status];
  assert.ok(documented, `Undocumented status: ${method} ${path} ${response.status}`);
  const schema = documented.content?.["application/json"]?.schema;
  if (!schema) { assert.equal(response.text, ""); return; }
  const key = `${method} ${path} ${response.status}`;
  if (!validators.has(key)) validators.set(key, ajv.compile(schema));
  const validate = validators.get(key);
  assert.equal(validate(response.body), true, JSON.stringify(validate.errors));
}
module.exports = { loadContract, assertResponse };
