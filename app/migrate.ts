import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

export async function migrate(pool: Pool, directory = resolve(process.cwd(), 'migrations')): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(731904202)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const names = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of names) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
      if (previous.rows[0]) {
        if (previous.rows[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  void migrate(pool).then(() => console.log('Migrations applied')).catch(() => {
    console.error('Migration failed; check database connectivity and migration checksums');
    process.exitCode = 1;
  }).finally(() => pool.end());
}
