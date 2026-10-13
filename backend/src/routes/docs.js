/**
 * Swagger documentation routes.
 *
 * Serves the generated OpenAPI UI, its initializer script, and the static
 * Swagger UI assets required for rendering the documentation page.
 */
const path = require("node:path");
const express = require("express");
const router = express.Router();

router.get("/", (_req, res) => res.sendFile(path.join(__dirname, "../docs/index.html")));
router.get("/initializer.js", (_req, res) => res.sendFile(path.join(__dirname, "../docs/initializer.js")));
router.use("/assets", express.static(require("swagger-ui-dist").getAbsoluteFSPath(), { index: false }));

module.exports = router;
