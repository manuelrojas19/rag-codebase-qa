// src/infra/queue/bullmq.queue.ts
import { Queue } from 'bullmq'
import Redis from 'ioredis'
import type { IIngestionQueue } from '../../ports/index.js'
import type { JobId, RepoId, RepoUrl } from '../../shared/types.js'
import { config } from '../../shared/config.js'

// BullMQ stores jobs in Redis as JSON.
// When you call enqueue(), the job data is written to Redis.
// The worker process (running separately) polls Redis and picks up jobs.
// If the worker crashes, the job stays in Redis and is retried automatically.

export class BullMQQueue implements IIngestionQueue {
    private queue: Queue

    constructor() {
        const connection = new Redis(config.redis.url, {
            maxRetriesPerRequest: null, // required by BullMQ
            enableReadyCheck: false,
        })

        this.queue = new Queue(config.queue.name, {
            connection: connection as any,
            defaultJobOptions: {
                attempts: config.queue.attempts,
                backoff: {
                    type: 'exponential',
                    delay: config.queue.backoffMs,
                    // Attempt 1: fail → wait 5s  → retry
                    // Attempt 2: fail → wait 10s → retry
                    // Attempt 3: fail → wait 20s → move to dead-letter queue
                },
                removeOnComplete: { count: 100 },  // keep last 100 completed jobs
                removeOnFail: { count: 500 },  // keep last 500 failed jobs
            },
        })
    }

    async enqueue(jobId: JobId, repoId: RepoId, repoUrl: RepoUrl): Promise<void> {
        await this.queue.add('ingest-repo', { jobId, repoId, repoUrl }, {
            jobId,  // use our DB job ID as BullMQ's ID — makes lookup easy
        })
    }

    async getState(jobId: JobId): Promise<string | null> {
        const job = await this.queue.getJob(jobId)
        return job ? await job.getState() : null
    }
}