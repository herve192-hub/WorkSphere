import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const [expectedNodeVersion, apiBase = "http://127.0.0.1:5000", webBase = "http://web:8080"] =
  process.argv.slice(2);

assert.ok(expectedNodeVersion, "Pass the Node.js version pinned in .nvmrc.");
assert.equal(process.versions.node, expectedNodeVersion, "API container Node.js version differs from .nvmrc.");
assert.notEqual(process.getuid(), 0, "API container must run without root.");
for (const command of ["npm", "npx"]) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error?.code, "ENOENT", `${command} must be absent from the API runtime image.`);
}
console.log("Verified API runs without root and excludes npm/npx build tools.");

async function request(base, path, status = 200) {
  const url = new URL(path, base);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, `${url} returned an unexpected HTTP status.`);
  return response;
}

const ready = await (await request(apiBase, "/health/ready")).json();
assert.equal(ready.status, "UP");
assert.equal(ready.service, "worksphere-api");
assert.equal(ready.dependencies.mongodb, "UP");
console.log("Verified API readiness, MongoDB connectivity, and pinned Node.js runtime.");

const protectedResponse = await request(apiBase, "/api/v1/employees", 401);
assert.ok((await protectedResponse.json()).error.message);
console.log("Verified unauthenticated employee requests are rejected.");

const protectedHistory = await request(apiBase, "/api/v1/audit", 401);
assert.ok((await protectedHistory.json()).error.message);
const spec = await (await request(apiBase, "/openapi.json")).json();
assert.equal(spec.info.title, "WorkSphere API");
assert.ok(spec.paths["/api/v1/audit"].get);
const docsResponse = await request(apiBase, "/docs/");
const csp = docsResponse.headers.get("content-security-policy") || "";
assert.match(csp, /script-src 'self'/);
if (process.env.NODE_ENV === "production") assert.match(csp, /upgrade-insecure-requests/);
else assert.doesNotMatch(csp, /upgrade-insecure-requests/);
const docs = await docsResponse.text();
assert.match(docs, /WorkSphere API documentation/);
for (const asset of ["swagger-ui.css", "swagger-ui-bundle.js"]) {
  const response = await request(apiBase, `/docs/assets/${asset}`);
  assert.match(response.headers.get("content-type") || "", asset.endsWith(".js") ? /javascript/i : /text\/css/i);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
}
console.log("Verified protected audit history, OpenAPI document, and local Swagger assets.");

const index = await request(webBase, "/");
assert.match(index.headers.get("content-type") || "", /text\/html/i);
const html = await index.text();
assert.match(html, /<title>WorkSphere<\/title>/);
assert.match(html, /<div\s+id="root"/);

const assets = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
assert.ok(assets.some((asset) => asset.endsWith(".js")), "Frontend HTML does not reference a JavaScript bundle.");
assert.ok(assets.some((asset) => asset.endsWith(".css")), "Frontend HTML does not reference a stylesheet.");
for (const asset of assets) {
  const response = await request(webBase, asset);
  const contentType = response.headers.get("content-type") || "";
  assert.match(contentType, asset.endsWith(".js") ? /javascript/i : /text\/css/i,
    `${asset} returned the wrong content type, possibly an HTML fallback.`);
  assert.ok((await response.arrayBuffer()).byteLength > 0, `${asset} is empty.`);
}

for (const path of ["/employees", "/audit"]) {
  const route = await request(webBase, path);
  assert.match(route.headers.get("content-type") || "", /text\/html/i);
  assert.equal(await route.text(), html, "Nginx must serve the SPA entry point for client-side routes.");
}
console.log("Verified frontend HTML, JavaScript, CSS, and client-side routing fallback.");
