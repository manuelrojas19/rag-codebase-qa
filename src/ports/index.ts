import type { Repository, ParsedRepoUrl } from '../domain/repo.js'
import type { CodeChunk, IndexedFile, ContentHash, SupportedLanguage } from '../domain/chunk.js'
import type { IndexingJob } from '../domain/job.js'
import type { Result, RepoId, RepoUrl, JobId, FileId, FilePath, ChunkId } from '../shared/types.js'

// ── Repo store port ───────────────────────────────────────────────────────────
export interface IRepoStore {
    findById(id: RepoId): Promise<Result<Repository | null>>
    findByUrl(url: RepoUrl): Promise<Result<Repository | null>>
    findAll(): Promise<Result<Repository[]>>
    upsert(repo: Repository): Promise<Result<Repository>>
    updateStatus(id: RepoId, patch: Partial<Pick<Repository,
        'status' | 'currentJobId' | 'lastCommitSha' | 'lastIndexedAt' | 'totalFiles' | 'totalChunks'
    >>): Promise<Result<void>>
}

// ── File index port ───────────────────────────────────────────────────────────
export interface IFileStore {
    findByPath(repoId: RepoId, path: FilePath): Promise<Result<IndexedFile | null>>
    upsert(file: IndexedFile): Promise<Result<void>>
    deleteByRepo(repoId: RepoId): Promise<Result<number>>
    listByRepo(repoId: RepoId): Promise<Result<IndexedFile[]>>
}

// ── Chunk store port ──────────────────────────────────────────────────────────
export interface IChunkStore {
    insertBatch(chunks: CodeChunk[]): Promise<Result<number>>
    deleteByFile(fileId: FileId): Promise<Result<number>>
    deleteByRepo(repoId: RepoId): Promise<Result<number>>
    countByRepo(repoId: RepoId): Promise<Result<number>>

    vectorSearch(
        embedding: number[],
        repoId: RepoId,
        limit: number,
    ): Promise<Result<ScoredChunk[]>>

    bm25Search(
        query: string,
        repoId: RepoId,
        limit: number,
    ): Promise<Result<ScoredChunk[]>>
}

export interface ScoredChunk {
    chunk: CodeChunk
    score: number
}

// ── Job store port ────────────────────────────────────────────────────────────
export interface IJobStore {
    create(job: IndexingJob): Promise<Result<IndexingJob>>
    findById(id: JobId): Promise<Result<IndexingJob | null>>
    findActiveByRepo(repoId: RepoId): Promise<Result<IndexingJob | null>>
    update(id: JobId, patch: Partial<IndexingJob>): Promise<Result<void>>
}

// ── Cache entry port ──────────────────────────────────────────────────────────
export interface ICacheEntryStore {
    findSimilar(
        questionEmbedding: number[],
        repoId: RepoId,
        threshold: number,
    ): Promise<Result<CachedAnswer | null>>

    save(entry: CachedAnswer): Promise<Result<void>>
    invalidateByRepo(repoId: RepoId): Promise<Result<number>>
    deleteExpired(): Promise<Result<number>>
}

export interface CachedAnswer {
    id: string
    repoId: RepoId
    question: string
    questionEmbedding: number[]
    answer: string
    sourceChunkIds: ChunkId[]
    expiresAt: Date
    createdAt: Date
}

// ── Embedding provider port ───────────────────────────────────────────────────
export interface IEmbeddingProvider {
    readonly model: string
    readonly dimensions: number
    embed(text: string): Promise<Result<number[]>>
    embedBatch(
        texts: string[],
        opts?: { batchSize?: number; onProgress?: (done: number, total: number) => void }
    ): Promise<Result<number[][]>>
}

// ── LLM provider port ─────────────────────────────────────────────────────────
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

export interface ILLMProvider {
    readonly model: string
    chat(messages: ChatMessage[]): Promise<Result<string>>
    chatStream(messages: ChatMessage[]): AsyncGenerator<Result<string>>
}

// ── Fast key-value cache port (Redis) ─────────────────────────────────────────
export interface IKVCache {
    get<T>(key: string): Promise<T | null>
    set<T>(key: string, value: T, ttlSeconds: number): Promise<void>
    del(key: string): Promise<void>
    delByPattern(pattern: string): Promise<number>
    ping(): Promise<boolean>
}

// ── Job queue port ────────────────────────────────────────────────────────────
export interface IIngestionQueue {
    enqueue(jobId: JobId, repoId: RepoId, repoUrl: RepoUrl): Promise<void>
    getState(jobId: JobId): Promise<string | null>
}

// ── Query log port ────────────────────────────────────────────────────────────
export interface IQueryLogger {
    log(entry: {
        repoId: RepoId | null
        question: string
        cacheHit: boolean
        semanticCacheHit: boolean
        chunksRetrieved: number
        durationMs: number
        retrievedChunkIds: ChunkId[]
    }): Promise<void>
}