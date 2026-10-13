/**
 * Audit event routes.
 *
 * Requires the caller to be authenticated and to have either the ADMIN or
 * HR_MANAGER role. These endpoints expose audit trail data for listing all
 * events or retrieving a single event by its id.
 */
const router = require("express").Router();
const { authenticate, allow } = require("../middleware/auth");
const audit = require("../services/auditService");

router.use(authenticate, allow("ADMIN", "HR_MANAGER"));
router.get("/", async (req, res) => res.json(await audit.listEvents(req.query)));
router.get("/:id", async (req, res) => res.json({ data: await audit.getEvent(req.params.id) }));

module.exports = router;
