const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

test("production imports use public domain boundaries", () => {
  const src = path.resolve(__dirname, "../src");
  const modules = path.join(src, "modules");
  const owner = (file) => {
    const relative = path.relative(modules, file);
    return relative.startsWith("..") ? null : relative.split(path.sep)[0];
  };
  // Guard the dependency direction as well as the folder layout. Test fixtures may
  // access private models, while production callers must use a domain's index.js.
  for (const file of readdirSync(src, { recursive: true }).filter((file) => file.endsWith(".js"))) {
    const absolute = path.join(src, file);
    const content = readFileSync(absolute, "utf8");
    for (const [, specifier] of content.matchAll(/require\(["']([^"']+)["']\)/g)) {
      if (!specifier.startsWith(".")) continue;
      const target = require.resolve(path.resolve(path.dirname(absolute), specifier));
      if (owner(target) && owner(target) !== owner(absolute))
        assert.equal(path.basename(target), "index.js", `${file} bypasses ${owner(target)}: ${specifier}`);
    }
  }
});
