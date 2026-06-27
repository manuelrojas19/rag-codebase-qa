// src/infra/db/client.ts
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '../../../drizzle/schema.js'
import { config } from '../../shared/config.js'

// Pool = a fixed set of Postgres connections kept open and reused.
// Without a pool: every query opens a new TCP connection (slow, expensive).
// With a pool:    connections are borrowed, used, and returned (fast).
const pool = new Pool({
    connectionString: config.db.url,
    max: config.db.poolMax,
    idleTimeoutMillis: config.db.poolIdleMs,
    connectionTimeoutMillis: 2_000,
})

pool.on('error', (err) => {
    // Log but don't crash — the pool will try to reconnect
    console.error('[db] Pool connection error:', err.message)
})

export const db = drizzle(pool, { schema })
export { pool }
export type DB = typeof db