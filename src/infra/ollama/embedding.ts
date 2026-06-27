import type { IEmbeddingProvider } from '../../ports/index.js'
import type { Result } from '../../shared/types.js'
import { Ok, Err, AppError } from '../../shared/types.js'
import { config } from '../../shared/config.js'

export class OllamaEmbedder implements IEmbeddingProvider {
    readonly model = config.ollama.embedModel
    readonly dimensions = config.ollama.dims

    async embed(text: string): Promise<Result<number[]>> {
        try {
            const res = await fetch(`${config.ollama.baseUrl}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, prompt: text }),
            })

            if (!res.ok) {
                return Err(AppError.embedFailed(`HTTP ${res.status}: ${await res.text()}`))
            }

            const data = await res.json() as { embedding: number[] }
            return Ok(data.embedding)
        } catch (e) {
            return Err(AppError.embedFailed(e instanceof Error ? e.message : String(e)))
        }
    }

    async embedBatch(
        texts: string[],
        opts: { batchSize?: number; onProgress?: (done: number, total: number) => void } = {},
    ): Promise<Result<number[][]>> {
        const { batchSize = 10, onProgress } = opts
        const results: number[][] = []

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize)

            // Run batch in parallel — but cap at batchSize to not overwhelm Ollama
            const batchResults = await Promise.all(batch.map(t => this.embed(t)))

            for (const r of batchResults) {
                if (!r.ok) return r   // propagate first error
                results.push(r.value)
            }

            onProgress?.(Math.min(i + batchSize, texts.length), texts.length)
        }

        return Ok(results)
    }
}