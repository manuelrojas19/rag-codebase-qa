import type {
    IChunkStore, IEmbeddingProvider, ILLMProvider,
    IQueryLogger, ScoredChunk,
} from '../ports/index.js'
import type { TwoLayerCache } from '../infra/cache/two-layer.cache.js'
import type { RepoId, ChunkId, Result } from '../shared/types.js'
import { Ok, Err, AppError } from '../shared/types.js'
import type { ChatMessage } from '../ports/index.js'

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Reciprocal Rank Fusion (RRF)
//
// Problem: vector search scores (0–1 cosine similarity) and BM25 scores
// (unbounded tf-idf floats) are on different scales. You can't average them.
//
// Solution: throw away the scores, only use RANKS.
//   RRF score = Σ 1 / (k + rank)   where k=60 (a constant that dampens high ranks)
//
// A document appearing in the TOP of BOTH lists scores highest.
// A document only in one list scores lower.
// This is scale-invariant — works regardless of what the original scores are.
//
// Example (k=60):
//   Doc A: vector rank 1, BM25 rank 1 → 1/61 + 1/61 = 0.0328
//   Doc B: vector rank 1, BM25 miss   → 1/61 + 0    = 0.0164
//   Doc C: vector rank 5, BM25 rank 2 → 1/65 + 1/62 = 0.0315
// ─────────────────────────────────────────────────────────────────────────────

export interface QueryResult {
    answer: string
    sources: SourceRef[]
    cacheHit: boolean
    semanticCacheHit: boolean
    durationMs: number
}

export interface SourceRef {
    filePath: string
    startLine: number
    content: string   // snippet preview
    rrfScore: number
}

export class QueryService {
    constructor(
        private chunks: IChunkStore,
        private embedder: IEmbeddingProvider,
        private llm: ILLMProvider,
        private cache: TwoLayerCache,
        private logger: IQueryLogger,
    ) { }

    async query(
        question: string,
        repoId: RepoId,
        topK = 5,
    ): Promise<Result<QueryResult>> {
        const start = Date.now()

        // ── 1. Embed the question ─────────────────────────────────────────────
        const embedResult = await this.embedder.embed(question)
        if (!embedResult.ok) return embedResult

        const qEmbedding = embedResult.value

        // ── 2. Cache lookup (fast path) ───────────────────────────────────────
        const cached = await this.cache.get(repoId, question, qEmbedding)
        if (cached) {
            const durationMs = Date.now() - start
            await this.logger.log({
                repoId, question,
                cacheHit: cached.hitType === 'exact',
                semanticCacheHit: cached.hitType === 'semantic',
                chunksRetrieved: 0,
                durationMs,
                retrievedChunkIds: cached.sourceChunkIds,
            })
            return Ok({
                answer: cached.answer,
                sources: [],  // not stored in cache for brevity
                cacheHit: cached.hitType === 'exact',
                semanticCacheHit: cached.hitType === 'semantic',
                durationMs,
            })
        }

        // ── 3. Hybrid search ──────────────────────────────────────────────────
        const CANDIDATE_LIMIT = topK * 4   // fetch 4x, RRF filters to topK

        const [vectorResult, bm25Result] = await Promise.all([
            this.chunks.vectorSearch(qEmbedding, repoId, CANDIDATE_LIMIT),
            this.chunks.bm25Search(question, repoId, CANDIDATE_LIMIT),
        ])

        if (!vectorResult.ok) return vectorResult

        const vectorHits = vectorResult.ok ? vectorResult.value : []
        const bm25Hits = bm25Result.ok ? bm25Result.value : []

        const merged = this.reciprocalRankFusion(vectorHits, bm25Hits, 60, topK)

        if (merged.length === 0) {
            return Err(AppError.noChunksFound(repoId, question))
        }

        // ── 4. Build prompt ───────────────────────────────────────────────────
        const context = merged
            .map((m, i) => [
                `### [${i + 1}] ${m.chunk.filePath} (line ${m.chunk.startLine})`,
                '```' + m.chunk.language,
                m.chunk.content,
                '```',
            ].join('\n'))
            .join('\n\n')

        const messages: ChatMessage[] = [
            {
                role: 'system',
                content: `You are a precise code assistant. Answer ONLY using the provided code context.
Reference file paths and line numbers. If the answer is not in the context, say so clearly.`,
            },
            {
                role: 'user',
                content: `${context}\n\nQuestion: ${question}`,
            },
        ]

        // ── 5. Generate answer ────────────────────────────────────────────────
        const llmResult = await this.llm.chat(messages)
        if (!llmResult.ok) return llmResult

        const answer = llmResult.value

        // ── 6. Format sources ─────────────────────────────────────────────────
        const sources: SourceRef[] = merged.map(m => ({
            filePath: m.chunk.filePath,
            startLine: m.chunk.startLine,
            content: m.chunk.content.slice(0, 200),
            rrfScore: m.rrfScore,
        }))

        const sourceChunkIds = merged.map(m => m.chunk.id)
        const durationMs = Date.now() - start

        // ── 7. Cache + log ────────────────────────────────────────────────────
        await Promise.all([
            this.cache.set(repoId, question, qEmbedding, answer, sourceChunkIds),
            this.logger.log({
                repoId, question,
                cacheHit: false,
                semanticCacheHit: false,
                chunksRetrieved: merged.length,
                durationMs,
                retrievedChunkIds: sourceChunkIds,
            }),
        ])

        return Ok({ answer, sources, cacheHit: false, semanticCacheHit: false, durationMs })
    }

    private reciprocalRankFusion(
        vectorHits: ScoredChunk[],
        bm25Hits: ScoredChunk[],
        k: number,
        topK: number,
    ): Array<ScoredChunk & { rrfScore: number }> {
        const scores = new Map<string, { sc: ScoredChunk; rrfScore: number }>()

        const contribute = (hits: ScoredChunk[], rank: number) => {
            hits.forEach((hit, i) => {
                const key = hit.chunk.id
                const existing = scores.get(key)
                const delta = 1 / (k + i + 1)
                if (existing) {
                    existing.rrfScore += delta
                } else {
                    scores.set(key, { sc: hit, rrfScore: delta })
                }
            })
        }

        contribute(vectorHits, 0)
        contribute(bm25Hits, 0)

        return Array.from(scores.values())
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .slice(0, topK)
            .map(({ sc, rrfScore }) => ({ ...sc, rrfScore }))
    }
}