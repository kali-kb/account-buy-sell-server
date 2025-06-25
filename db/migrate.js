const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const dotenv = require('dotenv');

dotenv.config();

// console.log(pro)

const runMigration = async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const db = drizzle(pool);

  await migrate(db, { migrationsFolder: './db/migrations' });
  await pool.end();
};

runMigration();