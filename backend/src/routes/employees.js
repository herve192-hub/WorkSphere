const router = require("express").Router();
const controller = require("../controllers/employeeController");
const { authenticate, allow } = require("../middleware/auth");

router.use(authenticate);
router.get("/", controller.list);
router.get("/:id", controller.getById);
router.post("/", allow("ADMIN", "HR_MANAGER"), controller.create);
router.patch("/:id", allow("ADMIN", "HR_MANAGER"), controller.update);
router.delete("/:id", allow("ADMIN"), controller.remove);

module.exports = router;
