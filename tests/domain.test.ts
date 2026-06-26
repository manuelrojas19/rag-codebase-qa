import { describe, expect, it } from 'bun:test'
import { parseRepoUrl, createRepository } from '../src/domain/repo.ts'
import { hashContent } from '../src/domain/chunk.ts'
import { createJob } from '../src/domain/job.ts'

describe('Domain Models', () => {
  describe('Repository', () => {
    it('should parse a valid GitHub URL', () => {
      const parsed = parseRepoUrl('https://github.com/honojs/hono')
      expect(parsed).not.toBeNull()
      expect(parsed).toEqual({
        provider: 'github',
        owner: 'honojs',
        name: 'hono',
        url: 'https://github.com/honojs/hono' as any,
        branch: 'main'
      })
    })

    it('should return null for invalid URL', () => {
      const parsed = parseRepoUrl('invalid-url')
      expect(parsed).toBeNull()
    })

    it('should create a repository with pending status', () => {
      const parsed = parseRepoUrl('https://github.com/honojs/hono')
      expect(parsed).not.toBeNull()
      if (parsed) {
        const repo = createRepository(parsed)
        expect(repo.id).toBeDefined()
        expect(repo.status).toBe('pending')
        expect(repo.name).toBe('hono')
        expect(repo.owner).toBe('honojs')
        expect(repo.provider).toBe('github')
        expect(repo.branch).toBe('main')
      }
    })
  })

  describe('Chunking & Hashing', () => {
    it('should generate same hash for same content and different hash for different content', () => {
      const hash1 = hashContent('function hello() {}')
      const hash2 = hashContent('function hello() {}')
      const hash3 = hashContent('function world() {}')
      
      expect(hash1.hex).toBe(hash2.hex)
      expect(hash1.hex).not.toBe(hash3.hex)
      expect(hash1.algorithm).toBe('sha256')
      expect(hash1.bytes).toBeGreaterThan(0)
    })
  })

  describe('Jobs', () => {
    it('should create a job with queued status', () => {
      const parsed = parseRepoUrl('https://github.com/honojs/hono')
      expect(parsed).not.toBeNull()
      if (parsed) {
        const repo = createRepository(parsed)
        const job = createJob(repo.id, 'manual')
        expect(job.id).toBeDefined()
        expect(job.repoId).toBe(repo.id)
        expect(job.status).toBe('queued')
        expect(job.trigger).toBe('manual')
      }
    })
  })
})
