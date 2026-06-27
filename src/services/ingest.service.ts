import simpleGit from 'simple-git'
import { glob } from 'glob'
import { readFile } from 'fs/promises'
import path from 'path'
import type {
    IRepoStore, IFileStore, IChunkStore,
    IJobStore, IEmbeddingProvider, IIngestionQueue,
} from '../ports/index.js'
import type { IndexingJob } from '../domain/job.js'
import { createChunk, detectLanguage, hashContent, type IndexedFile } from '../domain/chunk.js'
import { createJob } from '../domain/job.js'
import { ChunkerService } from './chunker.service.js'
import type { Result, RepoId, RepoUrl, JobId } from '../shared/types.js'
import { Ok, Err, AppError, FileId, FilePath } from '../shared/types.js'
import { config } from '../shared/config.js'

const CODE_GLOBS = [
    '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
    '**/*.py', '**/*.go', '**/*.java', '**/*.rs', '**/*.rb',
    '**/*.sql', '**/*.md', '**/*.sh', '**/*.yaml', '**/*.yml',
    '**/*.json', '**/*.toml',
]

const IGNORE_GLOBS = [
    '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**',
    '**/coverage/**', '**/.next/**', '**/__pycache__/**', '**/*.min.js',
    '**/vendor/**', '**/target/**', '**/*.map',
]

export class IngestService {
    private chunker = new ChunkerService(
        config.ingest.maxChunkSize,
    )

    constructor(
        private repos: IRepoStore,
        private files: IFileStore,
        private chunks: IChunkStore,
        private jobs: IJobStore,
        private embedder: IEmbeddingProvider,
        private queue: IIngestionQueue,
    ) { }

    // ── Called by the API: create job + enqueue ───────────────────────────────
    async scheduleIndexing(
        repoUrl: RepoUrl,
        trigger: IndexingJob['trigger'] = 'manual',
    ): Promise<Result<{ jobId: JobId }>> {

        // Find or create repo record
        const repoResult = await this.repos.findByUrl(repoUrl)
        if (!repoResult.ok) return repoResult

        if (!repoResult.value) {
            return Err(AppError.repoNotFound(repoUrl))
        }

        const repo = repoResult.value

        // Dedup — don't queue if already indexing
        const activeResult = await this.jobs.findActiveByRepo(repo.id)
        if (!activeResult.ok) return activeResult
        if (activeResult.value) {
            return Err(AppError.repoAlreadyIndexing(repoUrl, activeResult.value.id))
        }

        // Create job record
        const job = createJob(repo.id, trigger)
        const createResult = await this.jobs.create(job)
        if (!createResult.ok) return createResult

        // Update repo with current job
        await this.repos.updateStatus(repo.id, {
            status: 'indexing',
            currentJobId: job.id,
        })

        // Enqueue (BullMQ picks this up in the worker process)
        await this.queue.enqueue(job.id, repo.id, repoUrl)

        return Ok({ jobId: job.id })
    }

    // ── Called by the worker: actually do the indexing ────────────────────────
    async executeIndexing(
        jobId: JobId,
        repoId: RepoId,
        repoUrl: RepoUrl,
    ): Promise<Result<void>> {
        const cloneDir = path.join(config.ingest.cloneDir, `${repoId}-${Date.now()}`)

        const updateJob = async (patch: Partial<IndexingJob>) => {
            await this.jobs.update(jobId, patch)
        }

        // ── Step 1: Clone ────────────────────────────────────────────────────────
        await updateJob({ status: 'active', startedAt: new Date(), currentStep: 'Cloning repository' })

        try {
            await simpleGit().clone(repoUrl, cloneDir, ['--depth', '1', '--single-branch'])
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            await updateJob({ status: 'failed', errorMessage: msg, finishedAt: new Date() })
            return Err(AppError.cloneFailed(repoUrl, msg))
        }

        // ── Step 2: Discover files ───────────────────────────────────────────────
        const filePaths = await glob(CODE_GLOBS, { cwd: cloneDir, ignore: IGNORE_GLOBS })
        await updateJob({ filesTotal: filePaths.length, currentStep: `Found ${filePaths.length} files` })

        let filesDone = 0
        let chunksCreated = 0
        let chunksSkipped = 0

        // ── Step 3: Process each file ────────────────────────────────────────────
        for (const relPath of filePaths) {
            const fullPath = path.join(cloneDir, relPath)
            const fp = FilePath(relPath)

            let content: string
            try {
                const stat = Bun.file(fullPath)
                if (stat.size > config.ingest.maxFileSizeBytes) {
                    chunksSkipped++
                    continue
                }
                content = await readFile(fullPath, 'utf-8')
            } catch { continue }

            if (!content.trim()) continue

            const hash = hashContent(content)
            const language = detectLanguage(relPath)

            // ── Incremental check ─────────────────────────────────────────────────
            const existingFile = await this.files.findByPath(repoId, fp)
            if (!existingFile.ok) continue

            if (existingFile.value && existingFile.value.contentHash.hex === hash.hex) {
                // File unchanged → skip embedding entirely
                chunksSkipped += existingFile.value.chunkCount
                filesDone++
                continue
            }

            // File changed or new → delete old chunks, re-embed
            if (existingFile.value) {
                await this.chunks.deleteByFile(existingFile.value.id)
            }

            // ── Chunk ─────────────────────────────────────────────────────────────
            const rawChunks = this.chunker.chunk(content, language)
            if (rawChunks.length === 0) continue

            // ── Embed ─────────────────────────────────────────────────────────────
            const embedResult = await this.embedder.embedBatch(
                rawChunks.map(c => c.text),
                { batchSize: config.ingest.embedBatchSize },
            )
            if (!embedResult.ok) continue

            // ── Store file record ─────────────────────────────────────────────────
            const fileId = FileId(crypto.randomUUID())
            const indexedFile: IndexedFile = {
                id: fileId,
                repoId,
                filePath: fp,
                language,
                contentHash: hash,
                lineCount: content.split('\n').length,
                chunkCount: rawChunks.length,
                indexedAt: new Date(),
            }
            await this.files.upsert(indexedFile)

            // ── Store chunks ──────────────────────────────────────────────────────
            const domainChunks = rawChunks.map((raw, i) =>
                createChunk({
                    repoId,
                    fileId,
                    filePath: fp,
                    language,
                    content: raw.text,
                    chunkIndex: i,
                    totalChunks: rawChunks.length,
                    startLine: raw.startLine,
                    endLine: raw.endLine,
                    embedding: embedResult.value[i],
                })
            )

            const insertResult = await this.chunks.insertBatch(domainChunks)
            if (insertResult.ok) chunksCreated += insertResult.value

            filesDone++

            // Update progress every 5 files
            if (filesDone % 5 === 0) {
                const progress = Math.round((filesDone / filePaths.length) * 100)
                await updateJob({
                    progress,
                    filesDone,
                    chunksCreated,
                    chunksSkipped,
                    currentStep: `Embedding files (${filesDone}/${filePaths.length})`,
                })
            }
        }

        // ── Cleanup ───────────────────────────────────────────────────────────────
        await Bun.$`rm -rf ${cloneDir}`.quiet()

        await this.repos.updateStatus(repoId, {
            status: 'indexed',
            lastIndexedAt: new Date(),
            totalFiles: filesDone,
            totalChunks: chunksCreated,
        })

        await updateJob({
            status: 'completed',
            progress: 100,
            filesDone,
            chunksCreated,
            chunksSkipped,
            currentStep: 'Done',
            finishedAt: new Date(),
        })

        return Ok(undefined)
    }
}