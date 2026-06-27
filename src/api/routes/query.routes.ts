import { Hono } from 'hono'
import { streamText } from 'hono/streaming'
import type { QueryService } from '../../services/query.service.js'
import type { IRepoStore } from '../../ports/index.js'
import { RepoUrl } from '../../shared/types.js'

type Env = { Variables: { queryService: QueryService; repoStore: IRepoStore } }

export const queryRoutes = new Hono<Env>()

// POST /query
queryRoutes.post('/', async (c) => {
    const body = await c.req.json<{ question?: string; repoUrl?: string; topK?: number }>()

    if (!body.question || !body.repoUrl) {
        return c.json({ error: 'question and repoUrl are required' }, 400)
    }

    // Resolve repoUrl → repoId
    const repoResult = await c.get('repoStore').findByUrl(RepoUrl(body.repoUrl))
    if (!repoResult.ok) return c.json({ error: repoResult.error }, 500)
    if (!repoResult.value) return c.json({ error: 'Repository not indexed' }, 404)

    const result = await c.get('queryService').query(
        body.question,
        repoResult.value.id,
        body.topK ?? 5,
    )

    if (!result.ok) {
        if (result.error.code === 'NO_CHUNKS_FOUND') return c.json({ error: 'No relevant code found' }, 404)
        return c.json({ error: result.error }, 500)
    }

    return c.json(result.value)
})