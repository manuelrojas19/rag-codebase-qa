import type { SupportedLanguage } from '../domain/chunk.js'

export interface RawChunk {
    text: string
    startLine: number
    endLine: number
}

const SPLIT_PATTERNS: Record<SupportedLanguage | 'default', RegExp[]> = {
    typescript: [/(?=\n(?:export\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:async\s+)?\())/g, /(?=\n\n)/g],
    javascript: [/(?=\n(?:export\s+)?(?:async\s+)?(?:function|class))/g, /(?=\n\n)/g],
    python: [/(?=\n(?:def |class ))/g, /(?=\n\n)/g],
    go: [/(?=\nfunc )/g, /(?=\n\n)/g],
    java: [/(?=\n\s*(?:public|private|protected|static)\s)/g, /(?=\n\n)/g],
    rust: [/(?=\n(?:pub\s+)?fn )/g, /(?=\n\n)/g],
    ruby: [/(?=\ndef )/g, /(?=\n\n)/g],
    sql: [/(?=\n(?:CREATE|ALTER|INSERT|SELECT|DROP)\s)/gi, /(?=\n\n)/g],
    markdown: [/(?=\n#+\s)/g, /(?=\n\n)/g],
    bash: [/(?=\n\w+\(\))/g, /(?=\n\n)/g],
    yaml: [/(?=\n\w)/g],
    json: [/(?=\n  "[^"]+":)/g],
    toml: [/(?=\n\[)/g],
    plaintext: [/(?=\n\n\n)/g, /(?=\n\n)/g],
    default: [/(?=\n\n)/g],
}

export class ChunkerService {
    constructor(
        private maxChunkSize: number = 800,
        private minChunkSize: number = 50,
        private overlap: number = 100,
    ) { }

    chunk(content: string, language: SupportedLanguage): RawChunk[] {
        const patterns = SPLIT_PATTERNS[language] ?? SPLIT_PATTERNS.default
        const pieces = this.recursiveSplit(content, patterns, 0)
        const lines = content.split('\n')

        return pieces
            .filter(text => text.trim().length >= this.minChunkSize)
            .map(text => {
                const trimmed = text.trim()
                const startLine = this.findStartLine(content, trimmed, lines)
                return {
                    text: trimmed,
                    startLine,
                    endLine: startLine + trimmed.split('\n').length,
                }
            })
    }

    private recursiveSplit(text: string, patterns: RegExp[], depth: number): string[] {
        if (text.length <= this.maxChunkSize) return [text]
        if (depth >= patterns.length) return this.fixedSplit(text)

        const pattern = new RegExp(patterns[depth].source, patterns[depth].flags)
        const parts = text.split(pattern).filter(p => p.trim())
        if (parts.length <= 1) return this.recursiveSplit(text, patterns, depth + 1)

        return parts.flatMap(part =>
            part.length > this.maxChunkSize
                ? this.recursiveSplit(part, patterns, depth + 1)
                : [part]
        )
    }

    private fixedSplit(text: string): string[] {
        const chunks: string[] = []
        for (let i = 0; i < text.length; i += this.maxChunkSize - this.overlap) {
            chunks.push(text.slice(i, i + this.maxChunkSize))
        }
        return chunks
    }

    private findStartLine(content: string, chunk: string, lines: string[]): number {
        const probe = chunk.slice(0, 60)
        const idx = content.indexOf(probe)
        if (idx === -1) return 0
        return content.slice(0, idx).split('\n').length - 1
    }
}