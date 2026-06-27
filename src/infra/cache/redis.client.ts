// src/infra/cache/redis.client.ts
import Redis from 'ioredis'
import type { IKVCache } from '../../ports/index.js'
import { config } from '../../shared/config.js'

export class RedisKVCache implements IKVCache {
    private client: Redis

    constructor(url: string) {
        this.client = new Redis(url, {
            maxRetriesPerRequest: 3,
            // Don't crash the process if Redis is unavailable
            // Cache is a performance optimization, not critical path
            lazyConnect: true,
        })
        this.client.on('error', (err) => {
            console.warn('[cache] Redis error (non-fatal):', err.message)
        })
    }

    async get<T>(key: string): Promise<T | null> {
        try {
            const v = await this.client.get(key)
            return v ? JSON.parse(v) as T : null
        } catch { return null }
    }

    async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
        try {
            await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds)
        } catch { /* non-fatal */ }
    }

    async del(key: string): Promise<void> {
        try { await this.client.del(key) } catch { /* non-fatal */ }
    }

    async delByPattern(pattern: string): Promise<number> {
        try {
            // SCAN is non-blocking — safe for production (unlike KEYS which blocks)
            const keys: string[] = []
            let cursor = '0'
            do {
                const [next, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
                keys.push(...batch)
                cursor = next
            } while (cursor !== '0')

            if (keys.length > 0) await this.client.del(...keys)
            return keys.length
        } catch { return 0 }
    }

    async ping(): Promise<boolean> {
        try {
            return (await this.client.ping()) === 'PONG'
        } catch { return false }
    }
}