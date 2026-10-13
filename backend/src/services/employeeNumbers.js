/**
 * Utility for generating and initializing employee number counters.
 * Employee numbers use the format EMP-000001 and are stored in MongoDB.
 */
const COUNTER_ID = "employeeNumber";

/**
 * Finds the highest numeric suffix currently used by any employee number.
 * This is used to seed the shared counter without relying on document counts.
 *
 * @param {import('mongodb').Db} db - The connected MongoDB database instance.
 * @returns {Promise<number>} The largest employee number suffix currently present.
 * @throws {Error} If an existing employee number exceeds the supported safe integer range.
 */
async function highestEmployeeNumber(db) {
  let highest = 0;
  const records = db.collection("users").find(
    { employeeNumber: /^EMP-\d+$/ },
    { projection: { employeeNumber: 1 } },
  );
  for await (const record of records) {
    const value = Number(record.employeeNumber.slice(4));
    if (!Number.isSafeInteger(value))
      throw new Error("Existing employee number exceeds the supported sequence range.");
    highest = Math.max(highest, value);
  }
  return highest;
}

/**
 * Ensures the employee number counter exists and is initialized to the current
 * maximum employee number, or reseeded if explicitly requested.
 *
 * @param {import('mongodb').Db} db - The connected MongoDB database instance.
 * @param {Object} [options] - Initialization options.
 * @param {boolean} [options.reseed=false] - Whether to reset the counter to the current maximum.
 * @returns {Promise<void>}
 */
async function initializeEmployeeNumberCounter(db, { reseed = false } = {}) {
  const counters = db.collection("counters");
  if (!reseed && await counters.findOne({ _id: COUNTER_ID })) return;
  const update = { $max: { value: await highestEmployeeNumber(db) } };
  try {
    await counters.updateOne({ _id: COUNTER_ID }, update, { upsert: true });
  } catch (error) {
    // Another API process may have initialized the same counter first.
    if (error.code !== 11000) throw error;
    await counters.updateOne({ _id: COUNTER_ID }, update);
  }
}

/**
 * Allocates the next unique employee number from the MongoDB counter.
 * The value is incremented atomically in the database so all application instances
 * remain consistent even under parallel creation requests.
 *
 * @param {import('mongodb').Db} db - The connected MongoDB database instance.
 * @returns {Promise<string>} The next employee number in the format EMP-000001.
 * @throws {Error} If the counter is exhausted or invalid.
 */
async function nextEmployeeNumber(db) {
  await initializeEmployeeNumberCounter(db);
  // Allocate in MongoDB, never from a document count or an in-process counter.
  // Deletions and failed creates leave gaps rather than reusing identifiers.
  const counter = await db.collection("counters").findOneAndUpdate(
    { _id: COUNTER_ID, value: { $lt: Number.MAX_SAFE_INTEGER } },
    { $inc: { value: 1 } },
    { returnDocument: "after", includeResultMetadata: false },
  );
  if (!counter || !Number.isSafeInteger(counter.value) || counter.value < 1)
    throw new Error("Employee number sequence is exhausted or invalid.");
  return `EMP-${String(counter.value).padStart(6, "0")}`;
}

module.exports = { initializeEmployeeNumberCounter, nextEmployeeNumber };
