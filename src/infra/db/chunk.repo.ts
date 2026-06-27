// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Repository pattern
//
// The repository is the adapter that translates between:
//   Domain types (CodeChunk, IndexedFile)  ←→  Database rows (DbChunk, DbFileIndex)
//
// It implements the IChunkStore port.
// The application service calls IChunkStore — it never imports Drizzle directly.
// This means the service is testable without a database.
// ─────────────────────────────────────────────────────────────────────────────

import { eq, sql, and } from 'drizzle-orm'
import type { DB } from './client.js'
import { codeChunks, fileIndex } from '../../../drizzle/schema.js'
import type { IChunkStore, IFileStore, ScoredChunk } from '../../ports/index.js'
import type { CodeChunk, IndexedFile } from '../../domain/chunk.js'
import type { RepoId, FileId, FilePath, Result } from '../../shared/types.js'
import { Ok, Err, AppError, FileId as mkFileId } from '../../shared/types.js'

// ── File Index Repository ─────────────────────────────────────────────────────
export class PgFileStore implements IFileStore {
    constructor(private db: DB) { }

    async findByPath(repoId: RepoId, path: FilePath): Promise<Result<IndexedFile | null>> {
        try {
            const row = await this.db.query.fileIndex.findFirst({
                where: and(
                    eq(fileIndex.repoId, repoId),
                    eq(fileIndex.filePath, path),
                ),
            })
            if (!row) return Ok(null)
            return Ok(this.toDomain(row))
        } catch (e) {
            return Err(AppError.db('findByPath failed', e))
        }
    }

    async upsert(file: IndexedFile): Promise<Result<void>> {
        try {
            await this.db.insert(fileIndex).values({
                id: file.id,
                repoId: file.repoId,
                filePath: file.filePath,
                language: file.language,
                contentHash: file.contentHash.hex,
                fileSizeBytes: file.contentHash.bytes,
                lineCount: file.lineCount,
                chunkCount: file.chunkCount,
                indexedAt: file.indexedAt,
                lastSeenAt: new Date(),
            }).onConflictDoUpdate({
                target: [fileIndex.repoId, fileIndex.filePath],
                set: {
                    contentHash: file.contentHash.hex,
                    fileSizeBytes: file.contentHash.bytes,
                    lineCount: file.lineCount,
                    chunkCount: file.chunkCount,
                    indexedAt: file.indexedAt,
                    lastSeenAt: new Date(),
                },
            })
            return Ok(undefined)
        } catch (e) {
            return Err(AppError.db('upsert file failed', e))
        }
    }

    async deleteByRepo(repoId: RepoId): Promise<Result<number>> {
        try {
            const result = await this.db
                .delete(fileIndex)
                .where(eq(fileIndex.repoId, repoId))
                .returning({ id: fileIndex.id })
            return Ok(result.length)
        } catch (e) {
            return Err(AppError.db('deleteByRepo failed', e))
        }
    }

    async listByRepo(repoId: RepoId): Promise<Result<IndexedFile[]>> {
        try {
            const rows = await this.db.query.fileIndex.findMany({
                where: eq(fileIndex.repoId, repoId),
                orderBy: (t, { asc }) => asc(t.filePath),
            })
            return Ok(rows.map(r => this.toDomain(r)))
        } catch (e) {
            return Err(AppError.db('listByRepo failed', e))
        }
    }

    private toDomain(row: typeof fileIndex.$inferSelect): IndexedFile {
        return {
            id: row.id as unknown as import('../../shared/types.js').FileId,
            repoId: row.repoId as RepoId,
            filePath: row.filePath as FilePath,
            language: row.language,
            contentHash: { algorithm: 'sha256', hex: row.contentHash, bytes: row.fileSizeBytes },
            lineCount: row.lineCount,
            chunkCount: row.chunkCount,
            indexedAt: row.indexedAt,
        }
    }
}

// ── Chunk Repository ──────────────────────────────────────────────────────────
export class PgChunkStore implements IChunkStore {
    constructor(private db: DB, private pool: import('pg').Pool) { }

    async insertBatch(chunks: CodeChunk[]): Promise<Result<number>> {
        if (chunks.length === 0) return Ok(0)
        try {
            const rows = chunks.map(c => ({
                id: c.id,
                repoId: c.repoId,
                fileId: c.fileId,
                filePath: c.filePath,
                language: c.language,
                content: c.content,
                chunkIndex: c.chunkIndex,
                totalChunks: c.totalChunks,
                startLine: c.startLine,
                endLine: c.endLine,
                embedding: c.embedding,
            }))
            // Insert in batches of 100 to avoid huge parameter lists
            const BATCH = 100
            let inserted = 0
            for (let i = 0; i < rows.length; i += BATCH) {
                const batch = rows.slice(i, i + BATCH)
                await this.db.insert(codeChunks).values(batch).onConflictDoNothing()
                inserted += batch.length
            }
            return Ok(inserted)
        } catch (e) {
            return Err(AppError.db('insertBatch failed', e))
        }
    }

    async deleteByFile(fileId: FileId): Promise<Result<number>> {
        try {
            const result = await this.db
                .delete(codeChunks)
                .where(eq(codeChunks.fileId, fileId as unknown as string))
                .returning({ id: codeChunks.id })
            return Ok(result.length)
        } catch (e) {
            return Err(AppError.db('deleteByFile failed', e))
        }
    }

    async deleteByRepo(repoId: RepoId): Promise<Result<number>> {
        try {
            const result = await this.db
                .delete(codeChunks)
                .where(eq(codeChunks.repoId, repoId))
                .returning({ id: codeChunks.id })
            return Ok(result.length)
        } catch (e) {
            return Err(AppError.db('deleteByRepo failed', e))
        }
    }

    async countByRepo(repoId: RepoId): Promise<Result<number>> {
        try {
            const [{ count }] = await this.db
                .select({ count: sql<number>`count(*)::int` })
                .from(codeChunks)
                .where(eq(codeChunks.repoId, repoId))
            return Ok(count)
        } catch (e) {
            return Err(AppError.db('countByRepo failed', e))
        }
    }

    async vectorSearch(
        embedding: number[],
        repoId: RepoId,
        limit: number,
    ): Promise<Result<ScoredChunk[]>> {
        try {
            // Raw SQL for pgvector — Drizzle doesn't expose <=> natively yet
            const { rows } = await this.pool.query<{
                id: string; repo_id: string; file_id: string; file_path: string
                language: string; content: string; chunk_index: number; total_chunks: number
                start_line: number; end_line: number; embedding: string; created_at: Date
                distance: number
            }>(
                `SELECT *, (embedding <=> $1::vector) AS distance
         FROM code_chunks
         WHERE repo_id = $2
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
                [`[${embedding.join(',')}]`, repoId, limit],
            )
            return Ok(rows.map(r => ({
                score: 1 - r.distance,   // convert cosine distance → similarity
                chunk: this.rowToChunk(r),
            })))
        } catch (e) {
            return Err(AppError.db('vectorSearch failed', e))
        }
    }

    async bm25Search(
        query: string,
        repoId: RepoId,
        limit: number,
    ): Promise<Result<ScoredChunk[]>> {
        try {
            const { rows } = await this.pool.query<{
                id: string; repo_id: string; file_id: string; file_path: string
                language: string; content: string; chunk_index: number; total_chunks: number
                start_line: number; end_line: number; embedding: string; created_at: Date
                rank: number
            }>(
                `SELECT *, ts_rank(tsv_content, websearch_to_tsquery('english', $1)) AS rank
         FROM code_chunks
         WHERE repo_id = $2
           AND tsv_content @@ websearch_to_tsquery('english', $1)
         ORDER BY rank DESC
         LIMIT $3`,
                [query, repoId, limit],
            )
            return Ok(rows.map(r => ({ score: r.rank, chunk: this.rowToChunk(r) })))
        } catch (e) {
            return Err(AppError.db('bm25Search failed', e))
        }
    }

    private rowToChunk(r: {
        id: string; repo_id: string; file_id: string; file_path: string
        language: string; content: string; chunk_index: number; total_chunks: number
        start_line: number; end_line: number; embedding: string; created_at: Date
    }): CodeChunk {
        return {
            id: r.id as unknown as import('../../shared/types.js').ChunkId,
            repoId: r.repo_id as RepoId,
            fileId: r.file_id as unknown as FileId,
            filePath: r.file_path as FilePath,
            language: r.language as import('../../domain/chunk.js').SupportedLanguage,
            content: r.content,
            chunkIndex: r.chunk_index,
            totalChunks: r.total_chunks,
            startLine: r.start_line,
            endLine: r.end_line,
            embedding: typeof r.embedding === 'string'
                ? r.embedding.slice(1, -1).split(',').map(Number)
                : r.embedding as unknown as number[],
            createdAt: r.created_at,
        }
    }
}