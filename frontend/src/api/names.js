// Older API responses may still arrive while a deployment is being replaced.
// Keep the rest of the frontend on the canonical names.
export function normalizeNames(person) {
  if (!person) return person;
  const { firstname, lastname, ...data } = person;
  return {
    ...data,
    firstName: data.firstName ?? firstname,
    lastName: data.lastName ?? lastname,
  };
}
