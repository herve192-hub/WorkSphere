/**
 * Employee routes.
 *
 * All employee routes require authentication. The create and update endpoints are
 * restricted to administrators and HR managers, while deletion is limited to
 * administrators only.
 */
const router = require("express").Router();
const controller = require("./controller");
const { authenticate, allow } = require("../identity/index");

router.use(authenticate);

// List all employees.
router.get("/", controller.list);

// Fetch a single employee by id.
router.get("/:id", controller.getById);

// Create a new employee record.
router.post("/", allow("ADMIN", "HR_MANAGER"), controller.create);

// Update an employee record.
router.patch("/:id", allow("ADMIN", "HR_MANAGER"), controller.update);

// Remove an employee record.
router.delete("/:id", allow("ADMIN"), controller.remove);

module.exports = router;
