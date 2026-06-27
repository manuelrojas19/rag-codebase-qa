# codebase-qa

Ask natural language questions about any GitHub repository. Get answers grounded in the actual code.

```bash
curl -X POST https://api.your-domain.com/query \
  -H "Content-Type: application/json" \
  -d '{"question": "How does authentication work?", "repoUrl": "https://github.com/org/repo"}'
```

```json
{
  "answer": "Authentication is handled in src/middleware/auth.ts. The verifyJWT() function on line 12 validates the Bearer token from the Authorization header...",
  "sources": [
    { "filePath": "src/middleware/auth.ts", "startLine": 12, "rrfScore": 0.032 },
    { "filePath": "src/api/routes/user.routes.ts", "startLine": 44, "rrfScore": 0.028 }
  ],
  "cacheHit": false,
  "durationMs": 4821
}
```

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| API framework | [Hono](https://hono.dev) |
| Database | PostgreSQL 16 + [pgvector](https://github.com/pgvector/pgvector) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) |
| Job queue | [BullMQ](https://docs.bullmq.io) + Redis |
| Fast cache | Redis (ioredis) |
| Durable cache | PostgreSQL (semantic similarity via pgvector) |
| Embeddings | Ollama (`nomic-embed-text`) — swappable via `IEmbeddingProvider` |
| LLM | Ollama (`codellama:13b`) — swappable via `ILLMProvider` |
| Vector search | pgvector HNSW index, cosine similarity |
| Keyword search | PostgreSQL `tsvector` / BM25 |
| Search merge | Reciprocal Rank Fusion |

---

## Architecture

The system runs as two independent processes sharing a database and a Redis instance.

```mermaid
graph TB
    subgraph Clients
        WEB[Web / IDE]
        CLI[CLI]
        WH[GitHub Webhook]
    end

    subgraph API["API Process · Hono · :3000"]
        R_REPOS["POST /repos"]
        R_QUERY["POST /query"]
        R_HEALTH["GET /health"]
    end

    subgraph Worker["Worker Process · BullMQ"]
        W[Ingestion Worker<br/>concurrency: 2]
    end

    subgraph Storage
        PG[(PostgreSQL<br/>pgvector)]
        RD[(Redis)]
    end

    subgraph AI["AI Providers"]
        EMB[Ollama<br/>nomic-embed-text]
        LLM[Ollama<br/>codellama:13b]
        GH[GitHub<br/>git clone]
    end

    WEB & CLI & WH --> API
    R_REPOS -->|"enqueue job"| RD
    RD -->|"pick up job"| W
    W --> GH
    W --> EMB
    W --> PG

    R_QUERY --> EMB
    R_QUERY --> PG
    R_QUERY --> RD
    R_QUERY --> LLM

    style API fill:#1a1a2e,color:#e0e0e0,stroke:#4a4a8a
    style Worker fill:#1a2e1a,color:#e0e0e0,stroke:#4a8a4a
    style Storage fill:#2e1a1a,color:#e0e0e0,stroke:#8a4a4a
    style AI fill:#2e2a1a,color:#e0e0e0,stroke:#8a7a4a
```

### Dependency rule

Dependencies only point inward. Infrastructure knows about domain — domain never knows about infrastructure.

```mermaid
graph LR
    API["api/"] -->|calls| SVC["services/"]
    WRK["worker/"] -->|calls| SVC
    SVC -->|depends on| PRT["ports/"]
    SVC -->|uses| DOM["domain/"]
    INFRA["infra/"] -->|implements| PRT
    DOM -->|uses| SHR["shared/"]
    PRT -->|uses| SHR

    style SHR fill:#0d1117,stroke:#30363d,color:#c9d1d9
    style DOM fill:#0d1117,stroke:#238636,color:#c9d1d9
    style PRT fill:#0d1117,stroke:#1f6feb,color:#c9d1d9
    style SVC fill:#0d1117,stroke:#8957e5,color:#c9d1d9
    style INFRA fill:#0d1117,stroke:#da3633,color:#c9d1d9
    style API fill:#0d1117,stroke:#d29922,color:#c9d1d9
    style WRK fill:#0d1117,stroke:#d29922,color:#c9d1d9
```

Swapping Ollama for OpenAI, or Postgres for another database, requires changes only in `infra/` — services and domain are untouched.

---

## Ingestion pipeline

Triggered by `POST /repos`, `POST /webhooks/github`, or a cron schedule. The API returns `202 Accepted` immediately. The worker process handles the rest asynchronously.

```mermaid
sequenceDiagram
    participant API as API Server
    participant Queue as Redis / BullMQ
    participant Worker as Worker Process
    participant Git as GitHub
    participant Embed as Ollama Embeddings
    participant DB as PostgreSQL

    API->>DB: INSERT repositories (status=pending)
    API->>DB: INSERT indexing_jobs (status=queued)
    API->>Queue: enqueue job {jobId, repoId, repoUrl}
    API-->>Client: 202 { jobId }

    Queue->>Worker: pick up job

    Worker->>Git: git clone --depth 1
    Worker->>DB: UPDATE indexing_jobs (status=active)

    loop For each code file
        Worker->>DB: SELECT content_hash FROM file_index
        alt Hash unchanged
            Worker-->>Worker: skip file (chunksSkipped++)
        else Hash changed or new file
            Worker->>DB: DELETE FROM code_chunks WHERE file_id=?
            Worker->>Embed: embed batch of chunks (10 at a time)
            Embed-->>Worker: number[][] (768 floats each)
            Worker->>DB: INSERT file_index (new hash)
            Worker->>DB: INSERT code_chunks (with embeddings)
        end
    end

    Worker->>DB: UPDATE indexing_jobs (status=completed)
    Worker->>DB: UPDATE repositories (status=indexed, totalChunks=N)
    Worker->>Queue: invalidate cache keys for this repo
```

### Incremental indexing

Every file is SHA-256 hashed before embedding. On re-index, files whose hash matches the stored value are skipped entirely — no embedding calls made.

```mermaid
flowchart TD
    START([File discovered]) --> HASH[Compute SHA-256 of content]
    HASH --> CHECK{Stored hash\nexists?}
    CHECK -->|No| EMBED
    CHECK -->|Yes| MATCH{Hashes\nmatch?}
    MATCH -->|Yes| SKIP[Skip file\nchunksSkipped++]
    MATCH -->|No| DELETE[DELETE old chunks\nfor this file]
    DELETE --> EMBED[Chunk → Embed → Insert]
    EMBED --> UPSERT[UPSERT file_index\nwith new hash]
    SKIP --> NEXT([Next file])
    UPSERT --> NEXT

    style SKIP fill:#1a2e1a,stroke:#4a8a4a,color:#c9d1d9
    style EMBED fill:#1a1a2e,stroke:#4a4a8a,color:#c9d1d9
    style DELETE fill:#2e1a1a,stroke:#8a4a4a,color:#c9d1d9
```

| Run | Behaviour |
|---|---|
| First index (200 files) | All 200 files embedded |
| Re-index, nothing changed | 0 files embedded (all skipped) |
| Re-index, 10 files changed | 10 files embedded, 190 skipped |

---

## Query pipeline

```mermaid
sequenceDiagram
    participant Client
    participant API as API Server
    participant Redis as Redis Cache
    participant PG as PostgreSQL
    participant Embed as Ollama Embeddings
    participant LLM as Ollama LLM

    Client->>API: POST /query { question, repoUrl }

    API->>Embed: embed(question) → number[768]

    API->>Redis: GET qa:{repoId}:{question}
    alt Exact cache hit
        Redis-->>API: cached answer
        API-->>Client: 200 { answer, cacheHit: true }
    else Cache miss
        API->>PG: vector similarity search on cache_entries\n(cosine similarity > 0.92)
        alt Semantic cache hit
            PG-->>API: cached answer for similar question
            API->>Redis: SET key (warm Redis)
            API-->>Client: 200 { answer, semanticCacheHit: true }
        else Full miss
            par Hybrid search
                API->>PG: vector search (HNSW, cosine, top-20)
            and
                API->>PG: BM25 search (tsvector, top-20)
            end
            API->>API: Reciprocal Rank Fusion → top-5 chunks
            API->>LLM: chat(system + context chunks + question)
            LLM-->>API: answer text
            API->>Redis: SET result (TTL 1h)
            API->>PG: INSERT cache_entries (with question embedding)
            API->>PG: INSERT query_logs
            API-->>Client: 200 { answer, sources, durationMs }
        end
    end
```

### Cache layers

```mermaid
graph TD
    Q([Incoming question]) --> E[Embed question]
    E --> L1{Redis\nexact match?}
    L1 -->|hit < 1ms| ANS([Return answer])
    L1 -->|miss| L2{Postgres\nsemantic match\nsimilarity > 0.92?}
    L2 -->|hit ~5ms\nwarm Redis| ANS
    L2 -->|miss| VS[Vector search\n+ BM25 search]
    VS --> RRF[Reciprocal Rank Fusion]
    RRF --> LLM[LLM generation\n~4–30s]
    LLM --> WRITE[Write to Redis\n+ Postgres cache]
    WRITE --> ANS

    style L1 fill:#1a2e1a,stroke:#4a8a4a,color:#c9d1d9
    style L2 fill:#1a1a2e,stroke:#4a4a8a,color:#c9d1d9
    style LLM fill:#2e2a1a,stroke:#8a7a4a,color:#c9d1d9
```

**Redis** — exact key match, sub-millisecond, volatile (lost on flush).
**Postgres `cache_entries`** — semantic similarity via HNSW on question embeddings. Survives Redis restarts. Used to warm Redis on cold start.

---

## Database schema

```mermaid
erDiagram
    repositories {
        text id PK
        text url UK
        text name
        text owner
        vcs_provider provider
        text branch
        repo_status status
        text last_commit_sha
        int total_files
        int total_chunks
        text current_job_id
        timestamptz last_indexed_at
        timestamptz created_at
        timestamptz updated_at
    }

    indexing_jobs {
        text id PK
        text repo_id FK
        job_trigger trigger
        job_status status
        int progress
        text current_step
        int files_total
        int files_done
        int chunks_created
        int chunks_skipped
        text error_message
        timestamptz started_at
        timestamptz finished_at
        timestamptz created_at
    }

    file_index {
        text id PK
        text repo_id FK
        text file_path
        code_language language
        text content_hash
        int file_size_bytes
        int line_count
        int chunk_count
        timestamptz indexed_at
        timestamptz last_seen_at
    }

    code_chunks {
        text id PK
        text repo_id FK
        text file_id FK
        text file_path
        code_language language
        text content
        int chunk_index
        int total_chunks
        int start_line
        int end_line
        vector_768 embedding
        tsvector tsv_content
        timestamptz created_at
    }

    cache_entries {
        text id PK
        text repo_id FK
        text question
        vector_768 question_embedding
        text answer
        text[] source_chunk_ids
        int hit_count
        timestamptz last_hit_at
        timestamptz expires_at
        timestamptz created_at
    }

    query_logs {
        text id PK
        text repo_id FK
        text question
        bool cache_hit
        bool semantic_cache_hit
        int chunks_retrieved
        int duration_ms
        text[] retrieved_chunk_ids
        timestamptz created_at
    }

    repositories ||--o{ indexing_jobs    : "has"
    repositories ||--o{ file_index       : "has"
    repositories ||--o{ code_chunks      : "has"
    repositories ||--o{ cache_entries    : "has"
    repositories ||--o{ query_logs       : "has"
    file_index   ||--o{ code_chunks      : "has"
```

---

## Project structure

```
codebase-qa/
├── src/
│   ├── shared/
│   │   ├── types.ts          # Branded types, Result<T>, AppError
│   │   └── config.ts         # Validated env vars — fails fast at startup
│   │
│   ├── domain/               # Business entities — no infra imports
│   │   ├── repo.ts           # Repository entity, parseRepoUrl()
│   │   ├── chunk.ts          # CodeChunk entity, hashContent(), detectLanguage()
│   │   └── job.ts            # IndexingJob entity
│   │
│   ├── ports/
│   │   └── index.ts          # IRepoStore, IChunkStore, IJobStore,
│   │                         # IEmbeddingProvider, ILLMProvider,
│   │                         # IKVCache, IIngestionQueue, IQueryLogger
│   │
│   ├── infra/
│   │   ├── db/
│   │   │   ├── client.ts     # Postgres connection pool + Drizzle instance
│   │   │   ├── repo.repo.ts  # IRepoStore → Postgres
│   │   │   ├── chunk.repo.ts # IChunkStore + IFileStore → Postgres + pgvector
│   │   │   ├── job.repo.ts   # IJobStore → Postgres
│   │   │   └── query-logger.ts # IQueryLogger → Postgres
│   │   ├── cache/
│   │   │   ├── redis.client.ts    # IKVCache → Redis
│   │   │   ├── pg-cache.store.ts  # ICacheEntryStore → Postgres
│   │   │   └── two-layer.cache.ts # Redis + Postgres combined strategy
│   │   ├── ollama/
│   │   │   ├── embedding.ts  # IEmbeddingProvider → Ollama HTTP
│   │   │   └── llm.ts        # ILLMProvider → Ollama HTTP (stream + non-stream)
│   │   └── queue/
│   │       └── bullmq.queue.ts # IIngestionQueue → BullMQ + Redis
│   │
│   ├── services/
│   │   ├── chunker.service.ts  # Fixed / recursive / sliding-window strategies
│   │   ├── ingest.service.ts   # scheduleIndexing() + executeIndexing()
│   │   └── query.service.ts    # query() with hybrid search + RRF + cache
│   │
│   ├── api/
│   │   ├── server.ts           # Composition root — wires all dependencies
│   │   └── routes/
│   │       ├── repo.routes.ts  # POST /repos, GET /repos, GET /repos/:id/jobs/:jobId
│   │       └── query.routes.ts # POST /query
│   │
│   └── worker/
│       └── worker.ts           # BullMQ worker — runs as separate process
│
├── drizzle/
│   └── schema.ts               # All table definitions + Postgres enums
│
├── scripts/
│   ├── index-repo.ts           # CLI: index a repo manually
│   ├── test-embeddings.ts      # Verify Ollama is returning valid vectors
│   └── test-query.ts           # Run a query end-to-end from the CLI
│
├── docker-compose.yml          # Postgres 16 + pgvector, Redis 7
├── drizzle.config.ts
├── .env.example
├── package.json
└── tsconfig.json
```

---

## API reference

### `POST /repos`

Register a repository and schedule it for indexing.

**Request**
```json
{
  "url":     "https://github.com/org/repo",
  "branch":  "main",
  "trigger": "manual"
}
```

**Response** `202 Accepted`
```json
{
  "jobId":  "550e8400-e29b-41d4-a716-446655440000",
  "repoId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "status": "queued"
}
```

If the repository is already being indexed, returns `202` with `"status": "already_queued"` and the existing `jobId`.

---

### `GET /repos`

List all registered repositories.

**Response** `200 OK`
```json
{
  "repos": [
    {
      "id":           "6ba7b810-...",
      "url":          "https://github.com/org/repo",
      "name":         "repo",
      "owner":        "org",
      "status":       "indexed",
      "totalFiles":   87,
      "totalChunks":  312,
      "lastIndexedAt":"2024-01-15T10:30:00Z"
    }
  ]
}
```

---

### `GET /repos/:id/jobs/:jobId`

Poll indexing job progress.

**Response** `200 OK`
```json
{
  "id":            "550e8400-...",
  "status":        "active",
  "progress":      45,
  "currentStep":   "Embedding files (39/87)",
  "filesTotal":    87,
  "filesDone":     39,
  "chunksCreated": 156,
  "chunksSkipped": 12,
  "startedAt":     "2024-01-15T10:29:50Z"
}
```

`status` values: `queued` → `active` → `completed` | `failed`

---

### `POST /query`

Ask a natural language question about an indexed repository.

**Request**
```json
{
  "question": "How does the authentication middleware work?",
  "repoUrl":  "https://github.com/org/repo",
  "topK":     5
}
```

**Response** `200 OK`
```json
{
  "answer": "The authentication middleware is defined in src/middleware/auth.ts...",
  "sources": [
    {
      "filePath":  "src/middleware/auth.ts",
      "startLine": 12,
      "content":   "export async function authMiddleware(c: Context, next: Next) {",
      "rrfScore":  0.0328
    }
  ],
  "cacheHit":         false,
  "semanticCacheHit": false,
  "durationMs":       4821
}
```

---

### `GET /health`

```json
{ "status": "ok", "ts": "2024-01-15T10:30:00Z" }
```

Returns `503` if Postgres or Redis is unreachable.

---

## Local development

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.0
- [Docker Desktop](https://www.docker.com/products/docker-desktop)
- [Ollama](https://ollama.com) ≥ 0.3 (install steps below)

---

### 1. Install Ollama

**macOS**
```bash
brew install ollama
```
Or download the `.dmg` from [ollama.com/download](https://ollama.com/download/mac).

**Linux**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Windows**

Download the installer from [ollama.com/download](https://ollama.com/download/windows).

Verify the installation:
```bash
ollama --version
# ollama version 0.x.x
```

---

### 2. Pull the required models

This project uses two models — one for embeddings, one for answer generation.

```bash
# Start the Ollama server (keep this running in a terminal)
ollama serve

# In a new terminal, pull both models
ollama pull nomic-embed-text   # ~274 MB  — embedding model
ollama pull codellama:13b      # ~7.4 GB  — code-focused LLM
```

Verify both are available:
```bash
ollama list
# NAME                    ID              SIZE    MODIFIED
# codellama:13b           ...             7.4 GB  ...
# nomic-embed-text:latest ...             274 MB  ...
```

Verify embeddings work:
```bash
curl http://localhost:11434/api/embeddings \
  -d '{"model":"nomic-embed-text","prompt":"hello world"}'
# {"embedding":[0.034,...]}  ← array of 768 floats
```

Verify the LLM responds:
```bash
ollama run codellama:13b "What is a REST API? Answer in one sentence."
# A REST API is a set of rules...
```

#### Model selection guide

| Model | Size | RAM needed | Best for |
|---|---|---|---|
| `nomic-embed-text` | 274 MB | ~500 MB | Embeddings — always use this |
| `codellama:7b` | 3.8 GB | ~6 GB | Fast answers, lower quality |
| `codellama:13b` ✅ | 7.4 GB | ~10 GB | Good quality/speed balance — **recommended** |
| `deepseek-coder:6.7b` | 3.8 GB | ~6 GB | Alternative — excellent for code |
| `codellama:34b` | 19 GB | ~24 GB | Best quality, needs 32 GB RAM |

> **Apple Silicon (M1/M2/M3):** Ollama uses the GPU via Metal. `codellama:13b` runs
> comfortably on 16 GB unified memory. `codellama:34b` needs 32 GB.
>
> **Linux / Windows with NVIDIA GPU:** Ollama uses CUDA automatically if a GPU is
> detected. Any model that fits in VRAM runs on GPU; the rest spills to CPU RAM.
>
> **No GPU:** All models run on CPU. Expect `codellama:13b` to take 30–90s per
> answer instead of 3–10s. Use `codellama:7b` or `deepseek-coder:6.7b` for better speed.

To use a different LLM, update your `.env`:
```bash
OLLAMA_LLM_MODEL=deepseek-coder:6.7b
```
No code changes required — the model name is injected via `ILLMProvider`.

---

### 3. Project setup

```bash
# Clone and install dependencies
git clone https://github.com/your-org/codebase-qa
cd codebase-qa
bun install

# Copy and configure env vars
cp .env.example .env

# Start Postgres + Redis
docker compose up -d

# Push database schema
bun db:push

# Run the manual SQL setup (tsvector trigger + BM25 index)
docker exec -i rag_postgres psql -U dev -d codebase_qa < scripts/setup.sql
```

### 4. Run

```bash
# Terminal 1 — API server
bun run dev

# Terminal 2 — Worker (must run separately)
bun run worker
```

### 5. Index a repository

```bash
# Via CLI
bun run index https://github.com/honojs/hono

# Via API
curl -X POST http://localhost:3000/repos \
  -H "Content-Type: application/json" \
  -d '{"url":"https://github.com/honojs/hono"}'
```

### 6. Query

```bash
curl -X POST http://localhost:3000/query \
  -H "Content-Type: application/json" \
  -d '{"question":"How does routing work?","repoUrl":"https://github.com/honojs/hono"}'
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | Postgres connection string |
| `REDIS_URL` | ✅ | — | Redis connection string |
| `OLLAMA_BASE_URL` | | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_EMBED_MODEL` | | `nomic-embed-text` | Embedding model |
| `OLLAMA_LLM_MODEL` | | `codellama:13b` | Generation model |
| `OLLAMA_EMBED_DIMS` | | `768` | Embedding dimensions |
| `OLLAMA_NUM_CTX` | | `4096` | LLM context window |
| `MAX_FILE_SIZE_BYTES` | | `100000` | Skip files larger than this |
| `MAX_CHUNK_SIZE` | | `800` | Max chars per chunk |
| `EMBED_BATCH_SIZE` | | `10` | Parallel embedding calls |
| `CLONE_DIR` | | `/tmp/rag-repos` | Temporary clone directory |
| `WORKER_CONCURRENCY` | | `2` | Parallel indexing jobs |
| `CACHE_TTL_SEC` | | `3600` | Redis cache TTL |
| `SEMANTIC_CACHE_TTL_SEC` | | `3600` | Postgres cache TTL |
| `JOB_ATTEMPTS` | | `3` | BullMQ retry attempts |
| `JOB_BACKOFF_MS` | | `5000` | Initial backoff delay |
| `PORT` | | `3000` | API server port |

---

## Replacing AI providers

Both the embedding model and LLM are behind interfaces (`IEmbeddingProvider`, `ILLMProvider`). Switching to OpenAI requires a new adapter in `src/infra/` — services are unchanged.

```typescript
// src/infra/openai/embedding.ts
export class OpenAIEmbedder implements IEmbeddingProvider {
  readonly model      = 'text-embedding-3-small'
  readonly dimensions = 1536

  async embed(text: string): Promise<Result<number[]>> {
    // ...
  }
}
```

Then swap in `src/api/server.ts`:
```typescript
// Before
const embedder = new OllamaEmbedder()

// After
const embedder = new OpenAIEmbedder(process.env.OPENAI_API_KEY!)
```

> **Note:** switching embedding models requires re-indexing all repositories. Old and new embeddings live in different vector spaces and are not comparable.

---

## License

MIT