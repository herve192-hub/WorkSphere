module.exports = function notFound(_req, res) {
  res.status(404).json({
    error: { code: "ENDPOINT_NOT_FOUND", message: "Endpoint not found." },
  });
};
