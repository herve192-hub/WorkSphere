import assert from "node:assert/strict";

const [expectedNodeVersion, apiBase = "http://127.0.0.1:5000", webBase = "http://web"] =
  process.argv.slice(2);

assert.ok(expectedNodeVersion, "Pass the Node.js version pinned in .nvmrc.");
assert.equal(process.versions.node, expectedNodeVersion, "API container Node.js version differs from .nvmrc.");

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

const route = await request(webBase, "/employees");
assert.match(route.headers.get("content-type") || "", /text\/html/i);
assert.equal(await route.text(), html, "Nginx must serve the SPA entry point for client-side routes.");
console.log("Verified frontend HTML, JavaScript, CSS, and client-side routing fallback.");
