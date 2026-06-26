import {
    pgTable, pgEnum,
    text, integer, boolean, real,
    timestamp, index, uniqueIndex,
    customType,
} from 'drizzle-orm/pg-core'

const vector = (name: string, dims: number) =>
    customType<{ data: number[]; driverData: string }>({
        dataType: () => `vector(${dims})`,
        toDriver: (v: number[]) => `[${v.join(',')}]`,
        fromDriver: (v: string) => v.slice(1, -1).split(',').map(Number),
    })(name)

export const vcsProviderEnum = pgEnum('vcs_provider', ['github', 'gitlab', 'bitbucket'])
export const repoStatusEnum = pgEnum('repo_status', ['pending', 'indexing', 'indexed', 'failed'])
export const jobStatusEnum = pgEnum('job_status', ['queued', 'active', 'completed', 'failed', 'cancelled'])
export const jobTriggerEnum = pgEnum('job_trigger', ['manual', 'webhook', 'cron'])
export const languageEnum = pgEnum('code_language', [
    'typescript', 'javascript', 'python', 'go', 'java', 'rust',
    'ruby', 'sql', 'markdown', 'bash', 'yaml', 'json', 'toml', 'plaintext',
])


export const repositories = pgTable('repositories', {
    id: text('id').primaryKey(),
    url: text('url').notNull(),            // canonical: https://github.com/org/repo
    name: text('name').notNull(),            // repo name: "hono"
    owner: text('owner').notNull(),           // org/user: "honojs"
    provider: vcsProviderEnum('provider').notNull(),
    branch: text('branch').notNull().default('main'),
    status: repoStatusEnum('status').notNull().default('pending'),

    // Commit tracking — for webhook-driven incremental indexing.
    // When GitHub sends a push event, compare the pushed SHA to this.
    // If identical → nothing changed since last index → skip entirely.
    lastCommitSha: text('last_commit_sha'),

    // Denormalized counters — updated after each successful index.
    // Avoids expensive COUNT(*) queries on code_chunks for dashboards.
    totalFiles: integer('total_files').notNull().default(0),
    totalChunks: integer('total_chunks').notNull().default(0),

    currentJobId: text('current_job_id'),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    urlUnique: uniqueIndex('repositories_url_uniq').on(t.url),
    providerOwnerIdx: index('repositories_provider_owner_idx').on(t.provider, t.owner),
    statusIdx: index('repositories_status_idx').on(t.status),
}))

// ── Table 2: indexing_jobs ─────────────────────────────────────────────────────
// Complete audit trail of every indexing run.
// BullMQ state is ephemeral — this record is permanent.
export const indexingJobs = pgTable('indexing_jobs', {
    id: text('id').primaryKey(),
    repoId: text('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    trigger: jobTriggerEnum('trigger').notNull(),
    status: jobStatusEnum('status').notNull().default('queued'),
    progress: integer('progress').notNull().default(0),
    currentStep: text('current_step').notNull().default('Queued'),

    // Granular progress counters
    filesTotal: integer('files_total').notNull().default(0),
    filesDone: integer('files_done').notNull().default(0),
    chunksCreated: integer('chunks_created').notNull().default(0),

    // ─────────────────────────────────────────────────────────────────────────
    // CONCEPT: Tracking hash-skipped files
    // chunksSkipped tells you how effective incremental indexing is.
    // If you re-index and skip 95% of files → good cache hit rate.
    // If you skip 0% → either first index or everything changed (unusual).
    // Use this to tune your indexing strategy over time.
    // ─────────────────────────────────────────────────────────────────────────
    chunksSkipped: integer('chunks_skipped').notNull().default(0),

    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    repoIdx: index('indexing_jobs_repo_idx').on(t.repoId),
    statusIdx: index('indexing_jobs_status_idx').on(t.status),
    repoStatusIdx: index('indexing_jobs_repo_status_idx').on(t.repoId, t.status),
    createdAtIdx: index('indexing_jobs_created_at_idx').on(t.createdAt),
}))

// ── Table 3: file_index ───────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: File-level deduplication table
//
// This is the ENGINE of incremental indexing.
// One row per (repo, file path) pair.
//
// Before embedding any file:
//   SELECT content_hash FROM file_index WHERE repo_id=$1 AND file_path=$2
//   hash matches → skip (return chunksSkipped++)
//   hash differs → DELETE old chunks, re-embed, UPDATE this row
//   no row       → first time, embed, INSERT this row
//
// Why a separate table instead of storing hash in code_chunks?
//   - code_chunks has MANY rows per file (one per chunk)
//   - The hash check should be ONE query per file, not N queries
//   - This table gives you a clean "manifest" of what's indexed
//   - You can answer "list all indexed files" without touching the big table
// ─────────────────────────────────────────────────────────────────────────────
export const fileIndex = pgTable('file_index', {
    id: text('id').primaryKey(),
    repoId: text('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    filePath: text('file_path').notNull(),
    language: languageEnum('language').notNull(),

    // SHA-256 hex string (64 chars) of the full file content
    contentHash: text('content_hash').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    lineCount: integer('line_count').notNull(),
    chunkCount: integer('chunk_count').notNull(),

    // Track WHEN this file was indexed (useful for freshness dashboards)
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    // Primary lookup key: "do we have this file for this repo?"
    repoFileUniq: uniqueIndex('file_index_repo_file_uniq').on(t.repoId, t.filePath),
    hashIdx: index('file_index_hash_idx').on(t.contentHash),
    languageIdx: index('file_index_language_idx').on(t.repoId, t.language),
}))

// ── Table 4: code_chunks ──────────────────────────────────────────────────────
// The main table. One row per chunk. Each row has an embedding vector.
// pgvector searches this table to find relevant code.
export const codeChunks = pgTable('code_chunks', {
    id: text('id').primaryKey(),
    repoId: text('repo_id').notNull().references(() => repositories.id, { onDelete: 'cascade' }),
    fileId: text('file_id').notNull().references(() => fileIndex.id, { onDelete: 'cascade' }),

    // Denormalized — avoids a JOIN on every search query
    filePath: text('file_path').notNull(),
    language: languageEnum('language').notNull(),

    content: text('content').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    totalChunks: integer('total_chunks').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),

    // ─────────────────────────────────────────────────────────────────────────
    // CONCEPT: The embedding vector
    //
    // This column stores 768 floats — the semantic fingerprint of the code.
    // Same code = nearly identical vectors. Similar code = nearby vectors.
    // pgvector finds the K nearest vectors to a query vector efficiently.
    //
    // 768 dimensions = nomic-embed-text model output.
    // If you switch models (e.g. OpenAI text-embedding-3-small = 1536 dims),
    // you MUST re-index everything — old and new vectors are incompatible.
    // ─────────────────────────────────────────────────────────────────────────
    embedding: vector('embedding', 768).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    // ─────────────────────────────────────────────────────────────────────────
    // CONCEPT: HNSW index (Hierarchical Navigable Small World)
    //
    // Without an index: pgvector scans EVERY row and computes distance → O(n)
    // With HNSW:        navigates a graph of nearby vectors → O(log n) approx
    //
    // Trade-off: HNSW is APPROXIMATE — it may miss some closest vectors.
    // In practice for RAG, approximate is fine: you just need "good enough" chunks.
    //
    // Parameters:
    //   m=16:              connections per node — higher = better recall, more RAM
    //   ef_construction=64: graph build depth — higher = better index, slower build
    //
    // Alternative: IVFFlat index
    //   Clusters vectors into buckets, searches only relevant buckets.
    //   Better for very large datasets (millions of vectors).
    //   Requires training data (run ANALYZE after index creation).
    //   Use HNSW for < 1M vectors (our case).
    // ─────────────────────────────────────────────────────────────────────────
    embeddingIdx: index('code_chunks_embedding_hnsw_idx')
        .using('hnsw', t.embedding.op('vector_cosine_ops'))
        .with({ m: 16, ef_construction: 64 }),

    repoIdx: index('code_chunks_repo_idx').on(t.repoId),
    fileIdx: index('code_chunks_file_idx').on(t.fileId),
    repoFileIdx: index('code_chunks_repo_file_idx').on(t.repoId, t.filePath),
    languageIdx: index('code_chunks_language_idx').on(t.repoId, t.language),
}))

// ── Table 5: cache_entries ────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Why store cache in Postgres AND Redis?
//
// Redis (fast cache):
//   - Sub-millisecond reads
//   - Volatile — lost on flush/restart
//   - Perfect for short-lived exact matches
//
// Postgres cache_entries (durable cache):
//   - Persists across Redis restarts
//   - Queryable — "show me all cached answers for this repo"
//   - Stores the embedding for semantic similarity lookups
//   - Acts as warm-up source: on Redis restart, repopulate from here
//
// The two-layer strategy:
//   1. Check Redis (fast)   → hit? return immediately
//   2. Check Postgres cache → hit? warm Redis, return
//   3. Miss: run full pipeline, write to both
// ─────────────────────────────────────────────────────────────────────────────
export const cacheEntries = pgTable('cache_entries', {
    id: text('id').primaryKey(),
    repoId: text('repo_id').references(() => repositories.id, { onDelete: 'cascade' }),

    // The original question (for display + exact match)
    question: text('question').notNull(),

    // The embedding of the question — used for semantic similarity lookup
    questionEmbedding: vector('question_embedding', 768).notNull(),

    // The cached answer
    answer: text('answer').notNull(),

    // Which chunk IDs produced this answer (for debugging bad answers)
    sourceChunkIds: text('source_chunk_ids').array().notNull().default([]),

    hitCount: integer('hit_count').notNull().default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    // HNSW on the question embedding for fast semantic similarity lookup
    embeddingIdx: index('cache_entries_embedding_hnsw_idx')
        .using('hnsw', t.questionEmbedding.op('vector_cosine_ops'))
        .with({ m: 16, ef_construction: 64 }),

    repoIdx: index('cache_entries_repo_idx').on(t.repoId),
    expiresAtIdx: index('cache_entries_expires_at_idx').on(t.expiresAt),
}))

// ── Table 6: query_logs (observability) ──────────────────────────────────────
// Log every query — never skip this in prod. It's how you improve the system.
export const queryLogs = pgTable('query_logs', {
    id: text('id').primaryKey(),
    repoId: text('repo_id').references(() => repositories.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    cacheHit: boolean('cache_hit').notNull().default(false),
    semanticCacheHit: boolean('semantic_cache_hit').notNull().default(false),
    chunksRetrieved: integer('chunks_retrieved').notNull().default(0),
    durationMs: integer('duration_ms'),
    // Store which chunks were retrieved — helps debug why bad answers occurred
    retrievedChunkIds: text('retrieved_chunk_ids').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    repoIdx: index('query_logs_repo_idx').on(t.repoId),
    createdIdx: index('query_logs_created_at_idx').on(t.createdAt),
    cacheHitIdx: index('query_logs_cache_hit_idx').on(t.cacheHit),
}))

// Inferred TypeScript types from schema
export type DbRepo = typeof repositories.$inferSelect
export type NewDbRepo = typeof repositories.$inferInsert
export type DbJob = typeof indexingJobs.$inferSelect
export type NewDbJob = typeof indexingJobs.$inferInsert
export type DbFileIndex = typeof fileIndex.$inferSelect
export type NewDbFileIndex = typeof fileIndex.$inferInsert
export type DbChunk = typeof codeChunks.$inferSelect
export type NewDbChunk = typeof codeChunks.$inferInsert
export type DbCacheEntry = typeof cacheEntries.$inferSelect
export type NewDbCacheEntry = typeof cacheEntries.$inferInsert
export type DbQueryLog = typeof queryLogs.$inferSelect
export type NewDbQueryLog = typeof queryLogs.$inferInsert