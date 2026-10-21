const { MongoClient } = require("mongoose").mongo;

/** Worker processes own their client and require no API signing secret or HTTP listener. */
async function connectAuditDatabase(uri) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 10000 });
  try {
    await client.connect();
    const db = client.db();
    const topology = await db.admin().command({ hello: 1 });
    if (!topology.setName && topology.msg !== "isdbgrid") throw new Error("Audit delivery requires a replica set or sharded cluster.");
    return { client, db };
  } catch (error) {
    await client.close();
    throw error;
  }
}

module.exports = { connectAuditDatabase };
