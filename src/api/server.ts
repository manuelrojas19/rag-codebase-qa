import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { repoRoutes } from './routes/repo.routes.js'
import { queryRoutes } from './routes/query.routes.js'
import { config } from '../shared/config.js'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Dependency Injection via context
//
// Services and stores are created ONCE at startup and injected via Hono context.
// Routes never import infrastructure directly — they receive it.
// This makes routes testable: pass mock services in tests.
// ─────────────────────────────────────────────────────────────────────────────

type Env = {
    Variables: {
        ingestService: import('../services/ingest.service.js').IngestService
        queryService: import('../services/query.service.js').QueryService
        repoStore: import('../ports/index.js').IRepoStore
        jobStore: import('../ports/index.js').IJobStore
    }
}

export function createApp(deps: {
    ingestService: import('../services/ingest.service.js').IngestService
    queryService: import('../services/query.service.js').QueryService
    repoStore: import('../ports/index.js').IRepoStore
    jobStore: import('../ports/index.js').IJobStore
}) {
    const app = new Hono<Env>()

    // Inject dependencies into context
    app.use('*', async (c, next) => {
        c.set('ingestService', deps.ingestService)
        c.set('queryService', deps.queryService)
        c.set('repoStore', deps.repoStore)
        c.set('jobStore', deps.jobStore)
        await next()
    })

    // Request logger
    app.use('*', async (c, next) => {
        const t = Date.now()
        await next()
        console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - t}ms`)
    })

    app.get('/health', async (c) => c.json({ status: 'ok', ts: new Date().toISOString() }))
    app.route('/repos', repoRoutes)
    app.route('/query', queryRoutes)

    app.onError((err, c) => {
        console.error('[server] Unhandled error:', err)
        return c.json({ error: 'Internal server error' }, 500)
    })

    return app
}

// Bootstrap — wire everything together
async function bootstrap() {
    // Infra
    const { db, pool } = await import('../infra/db/client.js')
    const { PgRepoStore } = await import('../infra/db/repo.repo.js')
    const { PgFileStore, PgChunkStore } = await import('../infra/db/chunk.repo.js')
    const { PgJobStore } = await import('../infra/db/job.repo.js')
    const { RedisKVCache } = await import('../infra/cache/redis.client.js')
    const { PgCacheStore } = await import('../infra/cache/pg-cache.store.js')
    const { TwoLayerCache } = await import('../infra/cache/two-layer.cache.js')
    const { OllamaEmbedder } = await import('../infra/ollama/embedding.js')
    const { OllamaLLM } = await import('../infra/ollama/llm.js')
    const { BullMQQueue } = await import('../infra/queue/bullmq.queue.js')
    const { PgQueryLogger } = await import('../infra/db/query-logger.js')
    const { IngestService } = await import('../services/ingest.service.js')
    const { QueryService } = await import('../services/query.service.js')

    const repoStore = new PgRepoStore(db)
    const fileStore = new PgFileStore(db)
    const chunkStore = new PgChunkStore(db, pool)
    const jobStore = new PgJobStore(db)
    const kv = new RedisKVCache(config.redis.url)
    const pgCache = new PgCacheStore(db, pool)
    const cache = new TwoLayerCache(kv, pgCache, config.cache.semanticThreshold, config.cache.ttlSeconds)
    const embedder = new OllamaEmbedder()
    const llm = new OllamaLLM()
    const queue = new BullMQQueue()
    const queryLogger = new PgQueryLogger(db)

    const ingestService = new IngestService(repoStore, fileStore, chunkStore, jobStore, embedder, queue)
    const queryService = new QueryService(chunkStore, embedder, llm, cache, queryLogger)

    const app = createApp({ ingestService, queryService, repoStore, jobStore })
    const port = config.server.port

    serve({ fetch: app.fetch, port }, () => {
        console.log(`🚀 API server at http://localhost:${port}`)
        console.log(`   POST /repos              { url, branch?, trigger? }`)
        console.log(`   GET  /repos`)
        console.log(`   GET  /repos/:id/jobs/:jobId`)
        console.log(`   POST /query              { question, repoUrl, topK? }`)
        console.log(`   GET  /health`)
    })
}

bootstrap().catch(console.error)