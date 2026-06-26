import { createHash } from 'crypto'
import type { ChunkId, FileId, RepoId, FilePath } from '../shared/types.js'
import { ChunkId as makeChunkId } from '../shared/types.js'

export type SupportedLanguage =
    | 'typescript' | 'javascript' | 'python' | 'go'
    | 'java' | 'rust' | 'ruby' | 'sql' | 'markdown'
    | 'bash' | 'yaml' | 'json' | 'toml' | 'plaintext'

export interface ContentHash {
    readonly algorithm: 'sha256'
    readonly hex: string   // 64-char hex string
    readonly bytes: number   // original file size in bytes
}

export function hashContent(content: string): ContentHash {
    return {
        algorithm: 'sha256',
        hex: createHash('sha256').update(content, 'utf8').digest('hex'),
        bytes: Buffer.byteLength(content, 'utf8'),
    }
}

export interface IndexedFile {
    readonly id: FileId
    readonly repoId: RepoId
    readonly filePath: FilePath
    readonly language: SupportedLanguage
    readonly contentHash: ContentHash
    readonly lineCount: number
    readonly chunkCount: number
    readonly indexedAt: Date
}

export interface CodeChunk {
    readonly id: ChunkId
    readonly repoId: RepoId
    readonly fileId: FileId
    readonly filePath: FilePath       // denormalized — avoids JOIN on search
    readonly language: SupportedLanguage
    readonly content: string
    readonly chunkIndex: number         // 0-based position within the file
    readonly totalChunks: number         // total chunks in the file
    readonly startLine: number
    readonly endLine: number
    readonly embedding: number[]       // 768 floats (nomic-embed-text)
    readonly createdAt: Date
}

export function createChunk(params: Omit<CodeChunk, 'id' | 'createdAt'>): CodeChunk {
    return {
        ...params,
        id: makeChunkId(crypto.randomUUID()),
        createdAt: new Date(),
    }
}

// Extension map for language detection
const EXT_LANGUAGE_MAP: Record<string, SupportedLanguage> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python',
    go: 'go',
    java: 'java',
    rs: 'rust',
    rb: 'ruby',
    sql: 'sql',
    md: 'markdown', mdx: 'markdown',
    sh: 'bash', bash: 'bash',
    yaml: 'yaml', yml: 'yaml',
    json: 'json',
    toml: 'toml',
}

export function detectLanguage(filePath: string): SupportedLanguage {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    return EXT_LANGUAGE_MAP[ext] ?? 'plaintext'
}