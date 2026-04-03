# System Prompt Retrieval MCP

> **Shrink Claude's system prompt to a single line. Let the server load the rest on demand.**

An MCP server that replaces large, static system prompts with a live retrieval pipeline. Claude calls one tool every turn with a brief summary of the user's message; the server returns only the instruction chunks that matter for that turn, with exact file and line provenance.

---

## Why this exists

Large system prompts consume context on every turn — even when 90% of the instructions are irrelevant to what the user is doing right now. This server inverts that model:

- All instruction content lives in versioned markdown files in this repo.
- A hybrid BM25 + TF-IDF retriever with RRF fusion selects only the relevant chunks per turn.
- Claude's actual system prompt drops to a single instruction (see [Claude-side system prompt](#claude-side-system-prompt) below).
- Exact `line_start`/`line_end` provenance means Claude can always fetch the source if it needs more context.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Instruction repo (this repo)                           │
│                                                         │
│  communication/          operations/                    │
│  project-management/     …                              │
│  index.json              keywords.json                  │
│                                                         │
│  src/                                                   │
│    indexer.py      ← reads .md + index.json → Chunks    │
│    retriever.py    ← BM25 + TF-IDF + RRF fusion         │
│    query_parser.py ← verbs/objects/tags from summary    │
│    server.py       ← FastMCP server, 4 tools            │
│    evaluator.py    ← offline evaluation harness         │
└─────────────────────────────────────────────────────────┘
         │  MCP (stdio / SSE)
         ▼
┌─────────────────────────────────────────────────────────┐
│  Claude                                                 │
│  System prompt: one line → calls retrieve_instructions  │
│  every turn → uses returned chunks to guide response    │
└─────────────────────────────────────────────────────────┘
```

### Component responsibilities

| File | Responsibility |
|---|---|
| `src/indexer.py` | Reads markdown files + `index.json` → enriched `Chunk` objects with line provenance |
| `src/retriever.py` | BM25 + TF-IDF hybrid retrieval, RRF and convex fusion, confidence scoring, tag boosting. Zero external dependencies. |
| `src/query_parser.py` | Decomposes a task summary into verbs, objects, constraints, and matched tags. Builds an expanded query string. |
| `src/server.py` | FastMCP server. Exposes 4 tools (see below). Port is set on the `FastMCP` constructor via `MCP_PORT` env var. |
| `src/evaluator.py` | Full evaluation harness: Top-1 accuracy, Recall@k, MRR, line-span IoU, failure categorisation, multi-mode comparison. |
| `test_queries.json` | 30 labelled test cases with hard negatives. |
| `index.json` | Chunk metadata index — enriches raw markdown with summaries, tags, `instruction_type`, and line offsets. |
| `keywords.json` | Domain keyword list used by the query parser for tag inference and query expansion. |

### Retrieval pipeline

1. **Query parsing** — `QueryParser.parse(task_summary)` extracts verbs, objects, and constraints; infers tags; builds an expanded query string.
2. **BM25 stage** — term-frequency / inverse-document-frequency scoring over `text + summary + keywords` for each chunk.
3. **TF-IDF stage** — cosine similarity over a TF-IDF matrix of the same fields.
4. **Fusion** — Reciprocal Rank Fusion (RRF, default) or convex score combination merges both ranked lists.
5. **Tag boost** — chunks whose tags match inferred tags from the query receive a score multiplier.
6. **Confidence scoring** — each result is labelled `high`, `medium`, or `low` based on normalised fused score.

Default mode is `bm25` (empirically 80% Top-1 / 100% Recall@5 on the current 30-query test set). The hybrid path is retained for corpus growth beyond ~50 chunks where vocabulary mismatch becomes an issue.

### Chunk schema (`index.json`)

```json
{
  "chunk_id": "communication__response-gate__10_45",
  "file": "communication/response-gate.md",
  "section": "Response gate",
  "line_start": 10,
  "line_end": 45,
  "text": "Full instruction text…",
  "summary": "When and how to gate a response before sending.",
  "keywords": ["gate", "verify", "response", "check"],
  "tags": ["communication", "verification", "procedure"],
  "entities": [],
  "instruction_type": "procedure"
}
```

---

## MCP Tools

### `retrieve_instructions`
The primary tool. Called every turn with a brief summary of the user's message.

```
Inputs
  task_summary          str   1–3 sentence description of what the user wants
  top_k                 int   Number of chunks to return (default 5)
  mode                  str   "hybrid" | "bm25" | "tfidf" (default "hybrid")
  include_session_start bool  Inject session_start chunks on first turn

Returns  JSON with:
  query.{raw, verbs, objects, matched_tags}
  results[].{chunk_id, file, section, line_start, line_end,
             instruction_type, tags, summary, text,
             score, confidence, rank, method}
  meta.{total_chunks_in_index, mode, top_k}
```

### `get_instruction_lines`
Fetch raw source text from any instruction file between specific line numbers. Use when you need more context than `retrieve_instructions` returned.

```
Inputs
  file_path   str   Relative path from repo root (e.g. "communication/response-gate.md")
  line_start  int   First line, 1-indexed inclusive
  line_end    int   Last line, 1-indexed inclusive
```

### `list_instruction_chunks`
List all indexed chunks with optional filtering by tag or `instruction_type`. Useful for discovery.

```
Inputs
  filter_tag   str   Optional — only chunks with this tag
  filter_type  str   Optional — only chunks of this instruction_type
```

### `retriever_diagnostics`
Returns corpus stats: chunk count, total tokens indexed, BM25 vocabulary size, tag/type distribution, files indexed.

---

## Usage

### Prerequisites

- Python 3.11+
- `mcp[cli]` — `pip install mcp[cli]`

No other dependencies. The retriever uses only the Python standard library.

### Local (stdio)

```bash
# Run directly
python -m src

# Or via MCP CLI
mcp run src/server.py
```

### Remote / SSE

```bash
MCP_TRANSPORT=sse MCP_PORT=8080 python -m src
```

The port is read at import time and passed to the `FastMCP` constructor. To change the port, set `MCP_PORT` before starting the server.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` for local, `sse` for remote |
| `MCP_PORT` | `8080` | Port for SSE transport |
| `INSTRUCTION_BASE_DIR` | repo root | Path to the instruction file tree |
| `RETRIEVER_MODE` | `bm25` | Default retrieval mode (`bm25`, `tfidf`, `hybrid`) |

### Claude Desktop config

```json
{
  "mcpServers": {
    "instructions": {
      "command": "python",
      "args": ["-m", "src"],
      "cwd": "/path/to/progressive-claude-system-prompt-mcp"
    }
  }
}
```

---

## Claude-side system prompt

This is the entire system prompt you give Claude. Everything else comes from the retriever.

```
You have access to an MCP tool called retrieve_instructions.

At the start of EVERY turn, before you do anything else:
1. Call retrieve_instructions with a 1–3 sentence summary of what the user
   is asking for. Be specific: include the action (e.g. "write", "debug",
   "compare"), the subject (e.g. "Python async code", "GitHub PR"), and
   any constraints mentioned (e.g. "single file", "no external deps").
2. Read every returned chunk in full.
3. Follow the instructions in those chunks when constructing your response.

On the first turn of a new conversation, pass include_session_start=true.

Do not tell the user you are calling this tool unless they ask.
Do not summarise or paraphrase the returned instructions — apply them.
```

### Worked example

User says: *"Can you refactor this function to be async and add error handling?"*

Claude calls:
```json
{
  "task_summary": "Refactor a Python function to use async/await and add try/except error handling. User wants the same logic preserved.",
  "top_k": 5,
  "mode": "hybrid"
}
```

Server returns chunks tagged `["coding", "procedure", "verification"]` covering your async patterns, error handling rules, and response verification steps — and nothing else.

---

## Evaluation

```bash
# Run full evaluation across all modes
python -m src.evaluator --queries test_queries.json --mode all

# Run for a single mode
python -m src.evaluator --queries test_queries.json --mode bm25
```

The harness reports Top-1 accuracy, Recall@3, Recall@5, MRR, and line-span IoU. Failures are categorised as: wrong file, right file wrong lines, below-threshold, or no result.

---

## Adding instructions

1. Write or edit a markdown file in the appropriate subdirectory (`communication/`, `operations/`, `project-management/`, or a new one).
2. Add a corresponding entry to `index.json` with `chunk_id`, `file`, `line_start`, `line_end`, `summary`, `tags`, `keywords`, and `instruction_type`.
3. Add representative test queries to `test_queries.json` and run the evaluator to confirm retrieval quality.

---

## Design decisions

**Why BM25 as the default?**
BM25 reached 80% Top-1 accuracy and 100% Recall@5 on the current 30-query test set. The hybrid path (BM25 + TF-IDF + RRF) is preserved in the codebase because vocabulary mismatch grows as the corpus expands, but it adds latency and complexity that isn't justified yet. The evaluator makes it easy to switch.

**Why no external dependencies?**
The retriever is a pure-Python implementation of BM25 and TF-IDF. This keeps the server installable with a single `pip install mcp[cli]` and removes any risk of dependency conflicts in Claude Desktop or Smithery environments.

**Why line-level provenance?**
Returning `line_start`/`line_end` per chunk means Claude can call `get_instruction_lines` to fetch the exact source text without re-indexing or re-retrieving. It also makes the evaluation harness precise: line-span IoU measures whether retrieval is returning the right lines, not just the right file.

**Why RRF for fusion?**
Reciprocal Rank Fusion is rank-invariant, requiring no score normalisation across BM25 and TF-IDF. It degrades gracefully when one retriever has low confidence and is robust to score-scale differences — the right default for a system that may run in either `bm25`, `tfidf`, or `hybrid` mode without reconfiguration.
