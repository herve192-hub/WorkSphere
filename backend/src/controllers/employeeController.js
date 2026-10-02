const employeeService = require("../services/employeeService");

exports.list = async (req, res) => {
  const result = await employeeService.listEmployees(req.query, req.user);
  res.json(result);
};

exports.getById = async (req, res) => {
  res.json({ data: await employeeService.getEmployee(req.params.id, req.user) });
};

exports.create = async (req, res) => {
  res.status(201).json({ data: await employeeService.createEmployee(req.body) });
};

exports.update = async (req, res) => {
  res.json({ data: await employeeService.updateEmployee(req.params.id, req.body) });
};

exports.remove = async (req, res) => {
  await employeeService.deleteEmployee(req.params.id);
  res.sendStatus(204);
};
