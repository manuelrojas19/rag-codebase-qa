// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Two-layer cache
//
// Layer 1 — Redis (hot cache):
//   Sub-millisecond reads. Exact key match only.
//   Keys expire after TTL. Lost on Redis restart.
//   Use for: exact repeated questions, rate-limiting
//
// Layer 2 — Postgres cache_entries (warm cache):
//   Millisecond reads. Supports semantic similarity search via pgvector.
//   Persists across restarts. Stores question embeddings.
//   Use for: semantically similar questions, cache warm-up after Redis restart
//
// Read flow:
//   1. Redis GET {key}           → hit? return in <1ms
//   2. Postgres vector search    → hit (sim > 0.92)? warm Redis, return
//   3. Miss: full pipeline       → write to both layers
//
// Write flow:
//   - Always write to both layers simultaneously
//
// Invalidation:
//   - On repo re-index: delete all Redis keys matching pattern + Postgres rows
// ─────────────────────────────────────────────────────────────────────────────

import type { IKVCache } from '../../ports/index.js'
import type { ICacheEntryStore, CachedAnswer } from '../../ports/index.js'
import type { RepoId, ChunkId } from '../../shared/types.js'

export class TwoLayerCache {
    constructor(
        private kv: IKVCache,           // Redis
        private store: ICacheEntryStore,   // Postgres
        private threshold: number,         // semantic similarity cutoff
        private ttlSeconds: number,
    ) { }

    private redisKey(repoId: RepoId, question: string): string {
        // Normalize the question to increase exact match rate
        const normalized = question.toLowerCase().trim().replace(/\s+/g, ' ')
        return `qa:${repoId}:${normalized}`
    }

    async get(
        repoId: RepoId,
        question: string,
        questionEmbedding: number[],
    ): Promise<{ answer: string; sourceChunkIds: ChunkId[]; hitType: 'exact' | 'semantic' } | null> {

        // ── Layer 1: Redis exact match ─────────────────────────────────────────
        const key = this.redisKey(repoId, question)
        const fast = await this.kv.get<{ answer: string; sourceChunkIds: ChunkId[] }>(key)
        if (fast) return { ...fast, hitType: 'exact' }

        // ── Layer 2: Postgres semantic match ───────────────────────────────────
        const result = await this.store.findSimilar(questionEmbedding, repoId, this.threshold)
        if (!result.ok || !result.value) return null

        const cached = result.value

        // Warm Redis with this result (next exact/near-exact query will be fast)
        await this.kv.set(key, {
            answer: cached.answer,
            sourceChunkIds: cached.sourceChunkIds,
        }, this.ttlSeconds)

        return {
            answer: cached.answer,
            sourceChunkIds: cached.sourceChunkIds,
            hitType: 'semantic',
        }
    }

    async set(
        repoId: RepoId,
        question: string,
        questionEmbedding: number[],
        answer: string,
        sourceChunkIds: ChunkId[],
    ): Promise<void> {
        const payload = { answer, sourceChunkIds }
        const key = this.redisKey(repoId, question)

        // Write to both layers in parallel
        await Promise.all([
            this.kv.set(key, payload, this.ttlSeconds),
            this.store.save({
                id: crypto.randomUUID(),
                repoId,
                question,
                questionEmbedding,
                answer,
                sourceChunkIds,
                expiresAt: new Date(Date.now() + this.ttlSeconds * 1000),
                createdAt: new Date(),
            }),
        ])
    }

    async invalidateRepo(repoId: RepoId): Promise<void> {
        await Promise.all([
            this.kv.delByPattern(`qa:${repoId}:*`),
            this.store.invalidateByRepo(repoId),
        ])
    }
}