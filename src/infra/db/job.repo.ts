import { eq, and } from 'drizzle-orm'
import type { DB } from './client.js'
import { indexingJobs } from '../../../drizzle/schema.js'
import type { IJobStore } from '../../ports/index.js'
import type { IndexingJob, JobStatus, JobTrigger } from '../../domain/job.js'
import type { JobId, RepoId, Result } from '../../shared/types.js'
import { Ok, Err, AppError } from '../../shared/types.js'

export class PgJobStore implements IJobStore {
    constructor(private db: DB) { }

    async create(job: IndexingJob): Promise<Result<IndexingJob>> {
        try {
            await this.db.insert(indexingJobs).values({
                id: job.id,
                repoId: job.repoId,
                trigger: job.trigger,
                status: job.status,
                progress: job.progress,
                currentStep: job.currentStep,
                filesTotal: job.filesTotal,
                filesDone: job.filesDone,
                chunksCreated: job.chunksCreated,
                chunksSkipped: job.chunksSkipped,
                errorMessage: job.errorMessage,
                startedAt: job.startedAt,
                finishedAt: job.finishedAt,
                createdAt: job.createdAt,
            })
            return Ok(job)
        } catch (e) {
            return Err(AppError.db('create job failed', e))
        }
    }

    async findById(id: JobId): Promise<Result<IndexingJob | null>> {
        try {
            const row = await this.db.query.indexingJobs.findFirst({
                where: eq(indexingJobs.id, id),
            })
            if (!row) return Ok(null)
            return Ok(this.toDomain(row))
        } catch (e) {
            return Err(AppError.db(`findById failed for job id ${id}`, e))
        }
    }

    async findActiveByRepo(repoId: RepoId): Promise<Result<IndexingJob | null>> {
        try {
            const row = await this.db.query.indexingJobs.findFirst({
                where: and(
                    eq(indexingJobs.repoId, repoId),
                    eq(indexingJobs.status, 'active'),
                ),
            })
            if (!row) return Ok(null)
            return Ok(this.toDomain(row))
        } catch (e) {
            return Err(AppError.db(`findActiveByRepo failed for repo id ${repoId}`, e))
        }
    }

    async update(id: JobId, patch: Partial<IndexingJob>): Promise<Result<void>> {
        try {
            await this.db
                .update(indexingJobs)
                .set(patch)
                .where(eq(indexingJobs.id, id))
            return Ok(undefined)
        } catch (e) {
            return Err(AppError.db(`update failed for job id ${id}`, e))
        }
    }

    private toDomain(row: typeof indexingJobs.$inferSelect): IndexingJob {
        return {
            id: row.id as JobId,
            repoId: row.repoId as RepoId,
            trigger: row.trigger as JobTrigger,
            status: row.status as JobStatus,
            progress: row.progress,
            currentStep: row.currentStep,
            filesTotal: row.filesTotal,
            filesDone: row.filesDone,
            chunksCreated: row.chunksCreated,
            chunksSkipped: row.chunksSkipped,
            errorMessage: row.errorMessage,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            createdAt: row.createdAt,
        }
    }
}
