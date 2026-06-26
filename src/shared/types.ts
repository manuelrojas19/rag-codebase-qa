// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Branded (Opaque) Types
//
// A branded type is a primitive with a phantom tag.
// It's identical to string at runtime, but the compiler treats it differently.
//
// Problem without branding:
//   function getChunk(repoId: string, chunkId: string) { ... }
//   getChunk(chunkId, repoId)  ← compiles fine! silent bug
//
// With branding:
//   function getChunk(repoId: RepoId, chunkId: ChunkId) { ... }
//   getChunk(chunkId, repoId)  ← COMPILE ERROR. caught at build time.
// ─────────────────────────────────────────────────────────────────────────────

declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type RepoId = Brand<string, 'RepoId'>
export type ChunkId = Brand<string, 'ChunkId'>
export type FileId = Brand<string, 'FileId'>
export type JobId = Brand<string, 'JobId'>
export type RepoUrl = Brand<string, 'RepoUrl'>
export type CommitSha = Brand<string, 'CommitSha'>
export type FilePath = Brand<string, 'FilePath'>

// Constructors — validate + cast
export const RepoId = (s: string) => s as RepoId
export const ChunkId = (s: string) => s as ChunkId
export const FileId = (s: string) => s as FileId
export const JobId = (s: string) => s as JobId
export const CommitSha = (s: string) => s as CommitSha
export const FilePath = (s: string) => s as FilePath
export const RepoUrl = (s: string): RepoUrl => {
    if (!s.startsWith('https://')) throw new Error(`Invalid RepoUrl: ${s}`)
    return s as RepoUrl
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Result<T, E> — Explicit error handling
//
// Instead of throwing exceptions and hoping callers catch them,
// functions return a tagged union: either Ok(value) or Err(error).
// The compiler forces you to handle both cases.
//
// Benefits:
//   - No hidden control flow (throws are invisible in function signatures)
//   - Errors are documented in the type system
//   - Composable: pipe Results through transformations
// ─────────────────────────────────────────────────────────────────────────────

export type Result<T, E extends AppError = AppError> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E }

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E extends AppError>(error: E): Result<never, E> => ({ ok: false, error })

export function unwrap<T>(r: Result<T>): T {
    if (r.ok) return r.value
    throw new Error(`[${r.error.code}] ${JSON.stringify(r.error)}`)
}

export async function tryResult<T>(
    fn: () => Promise<T>,
    mapError: (e: unknown) => AppError,
): Promise<Result<T>> {
    try {
        return Ok(await fn())
    } catch (e) {
        return Err(mapError(e))
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCEPT: Discriminated Union Errors
//
// Each error has a unique string literal `code`.
// This lets you pattern-match exhaustively with switch/if statements.
// The compiler will warn you if you forget to handle a case.
//
// Compare to:
//   throw new Error("repo not found")   ← opaque string, hard to handle
//   return Err({ code: 'REPO_NOT_FOUND', repoUrl })  ← structured, matchable
// ─────────────────────────────────────────────────────────────────────────────

export type AppError =
    | { code: 'REPO_NOT_FOUND'; repoUrl: string }
    | { code: 'REPO_ALREADY_INDEXING'; repoUrl: string; jobId: JobId }
    | { code: 'JOB_NOT_FOUND'; jobId: JobId }
    | { code: 'UNSUPPORTED_HOST'; host: string }
    | { code: 'EMBED_FAILED'; reason: string }
    | { code: 'LLM_FAILED'; reason: string }
    | { code: 'CLONE_FAILED'; repoUrl: string; reason: string }
    | { code: 'DB_ERROR'; reason: string; cause?: unknown }
    | { code: 'VALIDATION'; field: string; reason: string }
    | { code: 'FILE_TOO_LARGE'; path: string; bytes: number }
    | { code: 'NO_CHUNKS_FOUND'; repoUrl: string; question: string }

export const AppError = {
    repoNotFound: (repoUrl: string) => ({ code: 'REPO_NOT_FOUND' as const, repoUrl }),
    repoAlreadyIndexing: (repoUrl: string, jobId: JobId) => ({ code: 'REPO_ALREADY_INDEXING' as const, repoUrl, jobId }),
    jobNotFound: (jobId: JobId) => ({ code: 'JOB_NOT_FOUND' as const, jobId }),
    unsupportedHost: (host: string) => ({ code: 'UNSUPPORTED_HOST' as const, host }),
    embedFailed: (reason: string) => ({ code: 'EMBED_FAILED' as const, reason }),
    llmFailed: (reason: string) => ({ code: 'LLM_FAILED' as const, reason }),
    cloneFailed: (repoUrl: string, reason: string) => ({ code: 'CLONE_FAILED' as const, repoUrl, reason }),
    db: (reason: string, cause?: unknown) => ({ code: 'DB_ERROR' as const, reason, cause }),
    validation: (field: string, reason: string) => ({ code: 'VALIDATION' as const, field, reason }),
    fileTooLarge: (path: string, bytes: number) => ({ code: 'FILE_TOO_LARGE' as const, path, bytes }),
    noChunksFound: (repoUrl: string, question: string) => ({ code: 'NO_CHUNKS_FOUND' as const, repoUrl, question }),
} satisfies Record<string, (...args: never[]) => AppError>