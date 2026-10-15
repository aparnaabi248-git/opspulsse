const mongoose = require('mongoose');

/**
 * Global Jest setup: one Mongo connection per test file.
 *
 * A separate database is used and every collection is emptied between tests
 * so no test can see another test's data. Your development database is never
 * modified.
 */

const mongoUri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/opspulse_test';

beforeAll(async () => {
  mongoose.set('strictQuery', true);
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
});

afterEach(async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.connection.close(false);
});