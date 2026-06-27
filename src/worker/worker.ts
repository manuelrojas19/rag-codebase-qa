// src/worker/worker.ts
// This is a SEPARATE PROCESS from the API server.
// Run it with: bun run worker
//
// It watches Redis for jobs placed there by IngestService.scheduleIndexing()
// When a job arrives, it calls IngestService.executeIndexing()
// If it crashes mid-job, BullMQ retries automatically

import { Worker } from 'bullmq'
import Redis from 'ioredis'
import { config } from '../shared/config.js'

// Wire up all dependencies (same as server.ts but without HTTP)
import { db, pool } from '../infra/db/client.js'
import { PgRepoStore } from '../infra/db/repo.repo.js'
import { PgFileStore, PgChunkStore } from '../infra/db/chunk.repo.js'
import { PgJobStore } from '../infra/db/job.repo.js'
import { OllamaEmbedder } from '../infra/ollama/embedding.js'
import { BullMQQueue } from '../infra/queue/bullmq.queue.js'
import { IngestService } from '../services/ingest.service.js'
import type { JobId, RepoId, RepoUrl } from '../shared/types.js'
import { JobId as mkJobId, RepoId as mkRepoId, RepoUrl as mkRepoUrl } from '../shared/types.js'

const repoStore = new PgRepoStore(db)
const fileStore = new PgFileStore(db)
const chunkStore = new PgChunkStore(db, pool)
const jobStore = new PgJobStore(db)
const embedder = new OllamaEmbedder()
const queue = new BullMQQueue()

const ingestService = new IngestService(
    repoStore, fileStore, chunkStore, jobStore, embedder, queue,
)

// BullMQ worker — concurrency: 2 means process 2 repos simultaneously
const worker = new Worker<{ jobId: string; repoId: string; repoUrl: string }>(
    config.queue.name,
    async (job) => {
        const { jobId, repoId, repoUrl } = job.data

        console.log(`[worker] Starting job ${jobId} for ${repoUrl}`)

        const result = await ingestService.executeIndexing(
            mkJobId(jobId),
            mkRepoId(repoId),
            mkRepoUrl(repoUrl),
        )

        if (!result.ok) {
            console.error(`[worker] Job ${jobId} failed:`, result.error)
            throw new Error(JSON.stringify(result.error))
            // Throwing causes BullMQ to retry per defaultJobOptions.attempts
        }

        console.log(`[worker] Job ${jobId} completed`)
    },
    {
        connection: new Redis(config.redis.url, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
        }) as any,
        concurrency: config.queue.concurrency,
    },
)

worker.on('completed', (job) => console.log(`[worker] ✅ ${job.id} done`))
worker.on('failed', (job, err) => console.error(`[worker] ❌ ${job?.id} failed:`, err.message))
worker.on('stalled', (jobId) => console.warn(`[worker] ⚠️ ${jobId} stalled, re-queued`))

console.log('[worker] 🚀 Listening for jobs...')

// Graceful shutdown: finish current jobs before exiting
process.on('SIGTERM', async () => {
    console.log('[worker] Shutting down...')
    await worker.close()
    process.exit(0)
})