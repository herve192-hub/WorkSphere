function profile(body = {}) {
  const { firstname, lastname, email } = body || {};
  if (
    ![firstname, lastname, email].every((v) => typeof v === "string") ||
    !firstname.trim() ||
    !lastname.trim() ||
    firstname.trim().length > 80 ||
    lastname.trim().length > 80 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    throw Object.assign(
      new Error("Enter your first name, last name, and a valid email address."),
      { status: 400 },
    );
  }
  return {
    firstname: firstname.trim(),
    lastname: lastname.trim(),
    email: email.trim().toLowerCase(),
  };
}
function password(value) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    Buffer.byteLength(value, "utf8") > 72
  )
    throw Object.assign(
      new Error(
        "Use a password with at least 12 characters and no more than 72 UTF-8 bytes.",
      ),
      { status: 400 },
    );
  return value;
}
module.exports = { profile, password };
