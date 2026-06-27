import { eq, lte, sql } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { cacheEntries } from '../../../drizzle/schema.js'
import type { ICacheEntryStore, CachedAnswer } from '../../ports/index.js'
import type { RepoId, ChunkId, Result } from '../../shared/types.js'
import { Ok, Err, AppError } from '../../shared/types.js'

export class PgCacheStore implements ICacheEntryStore {
    constructor(private db: DB, private pool: import('pg').Pool) { }

    async findSimilar(
        questionEmbedding: number[],
        repoId: RepoId,
        threshold: number,
    ): Promise<Result<CachedAnswer | null>> {
        try {
            // Find the closest cached question using pgvector cosine distance (<=>)
            const { rows } = await this.pool.query<{
                id: string
                repo_id: string
                question: string
                question_embedding: string
                answer: string
                source_chunk_ids: string[]
                hit_count: number
                last_hit_at: Date | null
                expires_at: Date
                created_at: Date
                distance: number
            }>(
                `SELECT *, (question_embedding <=> $1::vector) AS distance
                 FROM cache_entries
                 WHERE repo_id = $2
                   AND expires_at > NOW()
                 ORDER BY question_embedding <=> $1::vector
                 LIMIT 1`,
                [`[${questionEmbedding.join(',')}]`, repoId],
            )

            if (rows.length === 0) return Ok(null)

            const best = rows[0]
            const similarity = 1 - best.distance

            if (similarity < threshold) return Ok(null)

            // Increment hit count and update last hit time asynchronously (don't block the response)
            this.db.update(cacheEntries)
                .set({
                    hitCount: best.hit_count + 1,
                    lastHitAt: new Date(),
                })
                .where(eq(cacheEntries.id, best.id))
                .execute()
                .catch(err => console.warn('[cache] Failed to update cache hit metrics:', err))

            return Ok(this.rowToDomain(best))
        } catch (e) {
            return Err(AppError.db('findSimilar failed', e))
        }
    }

    async save(entry: CachedAnswer): Promise<Result<void>> {
        try {
            await this.db.insert(cacheEntries).values({
                id: entry.id,
                repoId: entry.repoId,
                question: entry.question,
                questionEmbedding: entry.questionEmbedding,
                answer: entry.answer,
                sourceChunkIds: entry.sourceChunkIds as string[],
                expiresAt: entry.expiresAt,
                createdAt: entry.createdAt,
            }).onConflictDoNothing() // or update, but typically cache entries are unique per id
            return Ok(undefined)
        } catch (e) {
            return Err(AppError.db('save cache entry failed', e))
        }
    }

    async invalidateByRepo(repoId: RepoId): Promise<Result<number>> {
        try {
            const result = await this.db
                .delete(cacheEntries)
                .where(eq(cacheEntries.repoId, repoId))
                .returning({ id: cacheEntries.id })
            return Ok(result.length)
        } catch (e) {
            return Err(AppError.db(`invalidateByRepo failed for repo id ${repoId}`, e))
        }
    }

    async deleteExpired(): Promise<Result<number>> {
        try {
            const result = await this.db
                .delete(cacheEntries)
                .where(lte(cacheEntries.expiresAt, new Date()))
                .returning({ id: cacheEntries.id })
            return Ok(result.length)
        } catch (e) {
            return Err(AppError.db('deleteExpired failed', e))
        }
    }

    private rowToDomain(r: {
        id: string
        repo_id: string
        question: string
        question_embedding: string | number[]
        answer: string
        source_chunk_ids: string[]
        expires_at: Date
        created_at: Date
    }): CachedAnswer {
        return {
            id: r.id,
            repoId: r.repo_id as RepoId,
            question: r.question,
            questionEmbedding: typeof r.question_embedding === 'string'
                ? r.question_embedding.slice(1, -1).split(',').map(Number)
                : r.question_embedding as number[],
            answer: r.answer,
            sourceChunkIds: r.source_chunk_ids as unknown as ChunkId[],
            expiresAt: r.expires_at,
            createdAt: r.created_at,
        }
    }
}
