const COUNTER_ID = "employeeNumber";

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
