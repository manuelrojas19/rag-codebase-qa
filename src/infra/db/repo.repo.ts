import { eq } from 'drizzle-orm'
import type { DB } from './client.js'
import { repositories } from '../../../drizzle/schema.js'
import type { IRepoStore } from '../../ports/index.js'
import type { Repository, VcsProvider, RepoStatus } from '../../domain/repo.js'
import type { RepoId, RepoUrl, Result, JobId, CommitSha } from '../../shared/types.js'
import { Ok, Err, AppError } from '../../shared/types.js'

export class PgRepoStore implements IRepoStore {
    constructor(private db: DB) { }

    async findById(id: RepoId): Promise<Result<Repository | null>> {
        try {
            const row = await this.db.query.repositories.findFirst({
                where: eq(repositories.id, id),
            })
            if (!row) return Ok(null)
            return Ok(this.toDomain(row))
        } catch (e) {
            return Err(AppError.db(`findById failed for repo id ${id}`, e))
        }
    }

    async findByUrl(url: RepoUrl): Promise<Result<Repository | null>> {
        try {
            const row = await this.db.query.repositories.findFirst({
                where: eq(repositories.url, url),
            })
            if (!row) return Ok(null)
            return Ok(this.toDomain(row))
        } catch (e) {
            return Err(AppError.db(`findByUrl failed for repo url ${url}`, e))
        }
    }

    async findAll(): Promise<Result<Repository[]>> {
        try {
            const rows = await this.db.query.repositories.findMany({
                orderBy: (t, { desc }) => desc(t.createdAt),
            })
            return Ok(rows.map(r => this.toDomain(r)))
        } catch (e) {
            return Err(AppError.db('findAll failed', e))
        }
    }

    async upsert(repo: Repository): Promise<Result<Repository>> {
        try {
            const values = {
                id: repo.id,
                url: repo.url,
                name: repo.name,
                owner: repo.owner,
                provider: repo.provider,
                branch: repo.branch,
                status: repo.status,
                lastCommitSha: repo.lastCommitSha,
                totalFiles: repo.totalFiles,
                totalChunks: repo.totalChunks,
                currentJobId: repo.currentJobId,
                lastIndexedAt: repo.lastIndexedAt,
                createdAt: repo.createdAt,
                updatedAt: new Date(),
            }
            await this.db.insert(repositories).values(values).onConflictDoUpdate({
                target: [repositories.url],
                set: {
                    status: repo.status,
                    lastCommitSha: repo.lastCommitSha,
                    totalFiles: repo.totalFiles,
                    totalChunks: repo.totalChunks,
                    currentJobId: repo.currentJobId,
                    lastIndexedAt: repo.lastIndexedAt,
                    updatedAt: new Date(),
                },
            })
            return Ok(repo)
        } catch (e) {
            return Err(AppError.db('upsert repo failed', e))
        }
    }

    async updateStatus(
        id: RepoId,
        patch: Partial<Pick<Repository, 'status' | 'currentJobId' | 'lastCommitSha' | 'lastIndexedAt' | 'totalFiles' | 'totalChunks'>>
    ): Promise<Result<void>> {
        try {
            await this.db
                .update(repositories)
                .set({
                    ...patch,
                    updatedAt: new Date(),
                })
                .where(eq(repositories.id, id))
            return Ok(undefined)
        } catch (e) {
            return Err(AppError.db(`updateStatus failed for repo id ${id}`, e))
        }
    }

    private toDomain(row: typeof repositories.$inferSelect): Repository {
        return {
            id: row.id as RepoId,
            url: row.url as RepoUrl,
            name: row.name,
            owner: row.owner,
            provider: row.provider as VcsProvider,
            branch: row.branch,
            status: row.status as RepoStatus,
            currentJobId: row.currentJobId as JobId | null,
            lastCommitSha: row.lastCommitSha as CommitSha | null,
            lastIndexedAt: row.lastIndexedAt,
            totalFiles: row.totalFiles,
            totalChunks: row.totalChunks,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        }
    }
}
