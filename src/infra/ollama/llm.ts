// src/infra/ollama/llm.ts
import type { ILLMProvider, ChatMessage } from '../../ports/index.js'
import type { Result } from '../../shared/types.js'
import { Ok, Err, AppError } from '../../shared/types.js'
import { config } from '../../shared/config.js'

export class OllamaLLM implements ILLMProvider {
    readonly model = config.ollama.llmModel

    async chat(messages: ChatMessage[]): Promise<Result<string>> {
        try {
            const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    stream: false,
                    options: {
                        temperature: config.ollama.temperature,
                        num_ctx: config.ollama.numCtx,
                    },
                }),
            })

            if (!res.ok) {
                return Err(AppError.llmFailed(`HTTP ${res.status}: ${await res.text()}`))
            }

            const data = await res.json() as { message: { content: string } }
            return Ok(data.message.content)
        } catch (e) {
            return Err(AppError.llmFailed(e instanceof Error ? e.message : String(e)))
        }
    }

    async *chatStream(messages: ChatMessage[]): AsyncGenerator<Result<string>> {
        try {
            const res = await fetch(`${config.ollama.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages,
                    stream: true,
                    options: { temperature: config.ollama.temperature },
                }),
            })

            if (!res.ok || !res.body) {
                yield Err(AppError.llmFailed(`HTTP ${res.status}`))
                return
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder()

            while (true) {
                const { done, value } = await reader.read()
                if (done) break

                for (const line of decoder.decode(value).split('\n').filter(Boolean)) {
                    try {
                        const chunk = JSON.parse(line) as { message?: { content: string }; done: boolean }
                        if (chunk.message?.content) yield Ok(chunk.message.content)
                        if (chunk.done) return
                    } catch { /* skip malformed lines */ }
                }
            }
        } catch (e) {
            yield Err(AppError.llmFailed(e instanceof Error ? e.message : String(e)))
        }
    }
}