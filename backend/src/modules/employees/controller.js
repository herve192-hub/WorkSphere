/**
 * Employee controller.
 * Handles HTTP requests for employee listing, lookup, creation,
 * updates, and deletion.
 * @module modules/employees/controller
 */
const employeeService = require("./service");

/**
 * Lists employees matching the provided query filters.
 *
 * @async
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends the employee list as JSON.
 */
exports.list = async (req, res) => {
  const result = await employeeService.listEmployees(req.query, req.user);
  res.json(result);
};

/**
 * Retrieves one employee by ID.
 *
 * @async
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends the employee payload as JSON.
 */
exports.getById = async (req, res) => {
  res.json({ data: await employeeService.getEmployee(req.params.id, req.user) });
};

/**
 * Creates a new employee.
 *
 * @async
 * @param {import('express').Request} req - Express request object containing employee data.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends the created employee with 201 status.
 */
exports.create = async (req, res) => {
  res.status(201).json({ data: await employeeService.createEmployee(req.body, { actor: req.user, requestId: req.requestId }) });
};

/**
 * Updates an existing employee.
 *
 * @async
 * @param {import('express').Request} req - Express request object containing employee updates.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Sends the updated employee payload as JSON.
 */
exports.update = async (req, res) => {
  res.json({ data: await employeeService.updateEmployee(req.params.id, req.body, { actor: req.user, requestId: req.requestId }) });
};

/**
 * Deletes an employee by ID.
 *
 * @async
 * @param {import('express').Request} req - Express request object.
 * @param {import('express').Response} res - Express response object.
 * @returns {Promise<void>} Returns HTTP 204 no content on success.
 */
exports.remove = async (req, res) => {
  await employeeService.deleteEmployee(req.params.id, { actor: req.user, requestId: req.requestId });
  res.sendStatus(204);
};
