// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Fail-fast configuration
//
// Read and validate ALL env vars at process startup.
// If anything is missing or malformed, crash immediately with a clear message.
// This prevents mysterious runtime errors minutes into a request.
//
// Alternative (bad): process.env.FOO scattered across the codebase,
// discovered only when that code path runs.
// ─────────────────────────────────────────────────────────────────────────────

function required(key: string): string {
    const v = process.env[key]
    if (v === undefined || v === '') throw new Error(`Missing env var: ${key}`)
    return v
}

function optional(key: string, fallback: string): string {
    return process.env[key] ?? fallback
}

function optInt(key: string, fallback: number): number {
    const v = process.env[key]
    if (!v) return fallback
    const n = parseInt(v, 10)
    if (Number.isNaN(n)) throw new Error(`Env var ${key} must be integer, got: ${v}`)
    return n
}

export const config = {
    db: {
        url: required('DATABASE_URL'),
        poolMax: optInt('DB_POOL_MAX', 10),
        poolIdleMs: optInt('DB_POOL_IDLE_MS', 30_000),
    },
    redis: {
        url: required('REDIS_URL'),
    },
    ollama: {
        baseUrl: optional('OLLAMA_BASE_URL', 'http://localhost:11434'),
        embedModel: optional('OLLAMA_EMBED_MODEL', 'nomic-embed-text'),
        llmModel: optional('OLLAMA_LLM_MODEL', 'codellama:13b'),
        dims: optInt('OLLAMA_EMBED_DIMS', 768),
        numCtx: optInt('OLLAMA_NUM_CTX', 4096),
        temperature: 0.1,
    },
    ingest: {
        maxFileSizeBytes: optInt('MAX_FILE_SIZE_BYTES', 100_000),
        maxChunkSize: optInt('MAX_CHUNK_SIZE', 800),
        embedBatchSize: optInt('EMBED_BATCH_SIZE', 10),
        cloneDir: optional('CLONE_DIR', '/tmp/rag-repos'),
    },
    cache: {
        ttlSeconds: optInt('CACHE_TTL_SEC', 3600),
        semanticTtlSeconds: optInt('SEMANTIC_CACHE_TTL_SEC', 3600),
        semanticThreshold: 0.92,     // cosine similarity — tune this
        maxSemanticEntries: 10_000,   // prevent unbounded growth
    },
    queue: {
        name: 'ingestion',
        concurrency: optInt('WORKER_CONCURRENCY', 2),
        attempts: optInt('JOB_ATTEMPTS', 3),
        backoffMs: optInt('JOB_BACKOFF_MS', 5_000),
    },
    server: {
        port: optInt('PORT', 3000),
    },
} as const

export type Config = typeof config