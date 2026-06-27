import { Hono } from 'hono'
import type { IngestService } from '../../services/ingest.service.js'
import type { IRepoStore, IJobStore } from '../../ports/index.js'
import { parseRepoUrl, createRepository } from '../../domain/repo.js'
import { RepoUrl, JobId } from '../../shared/types.js'

type Env = { Variables: { ingestService: IngestService; repoStore: IRepoStore; jobStore: IJobStore } }

export const repoRoutes = new Hono<Env>()

// POST /repos — register + schedule indexing
repoRoutes.post('/', async (c) => {
    const body = await c.req.json<{ url?: string; branch?: string; trigger?: string }>()

    if (!body.url) {
        return c.json({ error: 'url is required' }, 400)
    }

    const parsed = parseRepoUrl(body.url, body.branch)
    if (!parsed) {
        return c.json({ error: 'Invalid or unsupported repository URL' }, 400)
    }

    // Find or create the repo record
    const repoStore = c.get('repoStore')
    let repoResult = await repoStore.findByUrl(parsed.url)
    if (!repoResult.ok) return c.json({ error: repoResult.error }, 500)

    let repo = repoResult.value
    if (!repo) {
        repo = createRepository(parsed)
        const saveResult = await repoStore.upsert(repo)
        if (!saveResult.ok) return c.json({ error: saveResult.error }, 500)
        repo = saveResult.value
    }

    // Schedule indexing
    const ingest = c.get('ingestService')
    const trigger = (body.trigger ?? 'manual') as 'manual' | 'webhook' | 'cron'
    const result = await ingest.scheduleIndexing(parsed.url, trigger)

    if (!result.ok) {
        // Already indexing → return 202 with existing job
        if (result.error.code === 'REPO_ALREADY_INDEXING') {
            return c.json({ jobId: result.error.jobId, status: 'already_queued' }, 202)
        }
        return c.json({ error: result.error }, 500)
    }

    return c.json({ jobId: result.value.jobId, status: 'queued', repoId: repo.id }, 202)
})

// GET /repos — list all indexed repos
repoRoutes.get('/', async (c) => {
    const result = await c.get('repoStore').findAll()
    if (!result.ok) return c.json({ error: result.error }, 500)
    return c.json({ repos: result.value })
})

// GET /repos/:id/jobs/:jobId — job status
repoRoutes.get('/:id/jobs/:jobId', async (c) => {
    const jobId = JobId(c.req.param('jobId'))
    const result = await c.get('jobStore').findById(jobId)
    if (!result.ok) return c.json({ error: result.error }, 500)
    if (!result.value) return c.json({ error: 'Job not found' }, 404)
    return c.json(result.value)
})