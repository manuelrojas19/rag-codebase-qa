import type { DB } from './client.js'
import { queryLogs } from '../../../drizzle/schema.js'
import type { IQueryLogger } from '../../ports/index.js'
import type { RepoId, ChunkId } from '../../shared/types.js'

export class PgQueryLogger implements IQueryLogger {
    constructor(private db: DB) { }

    async log(entry: {
        repoId: RepoId | null
        question: string
        cacheHit: boolean
        semanticCacheHit: boolean
        chunksRetrieved: number
        durationMs: number
        retrievedChunkIds: ChunkId[]
    }): Promise<void> {
        try {
            await this.db.insert(queryLogs).values({
                id: crypto.randomUUID(),
                repoId: entry.repoId,
                question: entry.question,
                cacheHit: entry.cacheHit,
                semanticCacheHit: entry.semanticCacheHit,
                chunksRetrieved: entry.chunksRetrieved,
                durationMs: entry.durationMs,
                retrievedChunkIds: entry.retrievedChunkIds as string[],
                createdAt: new Date(),
            })
        } catch (e) {
            console.error('[query-logger] Failed to log query to database:', e)
        }
    }
}
