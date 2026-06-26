import type { JobId, RepoId } from '../shared/types.js'
import { JobId as makeJobId } from '../shared/types.js'

export type JobStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled'
export type JobTrigger = 'manual' | 'webhook' | 'cron'

export interface IndexingJob {
    readonly id: JobId
    readonly repoId: RepoId
    readonly trigger: JobTrigger
    status: JobStatus
    progress: number        // 0-100 integer
    currentStep: string        // "Embedding 42/87 files"
    filesTotal: number
    filesDone: number
    chunksCreated: number
    chunksSkipped: number        // skipped — hash match, no re-embed needed
    errorMessage: string | null
    startedAt: Date | null
    finishedAt: Date | null
    readonly createdAt: Date
}

export function createJob(repoId: RepoId, trigger: JobTrigger): IndexingJob {
    return {
        id: makeJobId(crypto.randomUUID()),
        repoId,
        trigger,
        status: 'queued',
        progress: 0,
        currentStep: 'Queued',
        filesTotal: 0,
        filesDone: 0,
        chunksCreated: 0,
        chunksSkipped: 0,
        errorMessage: null,
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
    }
}