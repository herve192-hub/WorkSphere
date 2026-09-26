const router = require("express").Router();
const mongoose = require("mongoose");
const Employee = require("../models/Employee");
const { authenticate, allow } = require("../middleware/auth");
const { profile } = require("../services/validation");
router.use(authenticate);
router.get("/", async (req, res) => {
  const filter = req.user.role === "EMPLOYEE" ? { email: req.user.email } : {};
  res.json({
    data: await Employee.find(filter)
      .sort({ createdAt: -1 })
      .select("firstname lastname email createdAt updatedAt"),
  });
});
router.post("/", allow("ADMIN", "HR_MANAGER"), async (req, res) =>
  res.status(201).json({ data: await Employee.create(profile(req.body)) }),
);
router.param("id", (req, res, next, id) =>
  mongoose.isObjectIdOrHexString(id)
    ? next()
    : res.status(400).json({ error: { message: "Invalid employee ID." } }),
);
router.patch("/:id", allow("ADMIN", "HR_MANAGER"), async (req, res) => {
  const employee = await Employee.findByIdAndUpdate(
    req.params.id,
    profile(req.body),
    { new: true, runValidators: true },
  );
  if (!employee)
    return res.status(404).json({ error: { message: "Employee not found." } });
  res.json({ data: employee });
});
router.delete("/:id", allow("ADMIN"), async (req, res) => {
  const employee = await Employee.findByIdAndDelete(req.params.id);
  if (!employee)
    return res.status(404).json({ error: { message: "Employee not found." } });
  res.sendStatus(204);
});
module.exports = router;
