import type { RepoId, RepoUrl, JobId, CommitSha } from '../shared/types.js'
import { RepoId as makeRepoId } from '../shared/types.js'

export type RepoStatus = 'pending' | 'indexing' | 'indexed' | 'failed'
export type VcsProvider = 'github' | 'gitlab' | 'bitbucket'

export interface Repository {
    readonly id: RepoId
    readonly url: RepoUrl
    readonly name: string        // "hono"
    readonly owner: string        // "honojs"
    readonly provider: VcsProvider
    readonly branch: string        // "main"
    status: RepoStatus
    currentJobId: JobId | null
    lastCommitSha: CommitSha | null  // last successfully indexed commit
    lastIndexedAt: Date | null
    totalFiles: number            // denormalized for fast dashboards
    totalChunks: number
    readonly createdAt: Date
    updatedAt: Date
}

// ── Value Object: parsed repo URL ─────────────────────────────────────────────
// CONCEPT: Value Object — no identity, defined by its attributes
// Two ParsedRepoUrls with the same values ARE the same thing.
export interface ParsedRepoUrl {
    readonly provider: VcsProvider
    readonly owner: string
    readonly name: string
    readonly url: RepoUrl
    readonly branch: string
}

const HOST_PROVIDER_MAP: Record<string, VcsProvider> = {
    'github.com': 'github',
    'gitlab.com': 'gitlab',
    'bitbucket.org': 'bitbucket',
}

export function parseRepoUrl(raw: string, branch = 'main'): ParsedRepoUrl | null {
    try {
        const url = new URL(raw.trim())
        const host = url.hostname.replace('www.', '')
        const provider = HOST_PROVIDER_MAP[host]
        if (!provider) return null

        const segments = url.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
        if (segments.length < 2) return null

        const [owner, name] = segments as [string, string]
        if (!owner || !name) return null

        const cleanUrl = `https://${host}/${owner}/${name}` as RepoUrl
        return { provider, owner, name, url: cleanUrl, branch }
    } catch {
        return null
    }
}

export function createRepository(parsed: ParsedRepoUrl): Repository {
    const now = new Date()
    return {
        id: makeRepoId(crypto.randomUUID()),
        url: parsed.url,
        name: parsed.name,
        owner: parsed.owner,
        provider: parsed.provider,
        branch: parsed.branch,
        status: 'pending',
        currentJobId: null,
        lastCommitSha: null,
        lastIndexedAt: null,
        totalFiles: 0,
        totalChunks: 0,
        createdAt: now,
        updatedAt: now,
    }
}