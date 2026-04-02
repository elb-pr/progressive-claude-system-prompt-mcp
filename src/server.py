"""
Progressive Claude System Prompt — MCP Server

This server IS the instruction database. Claude's system prompt shrinks to:
  "Every turn, call retrieve_instructions with a brief summary of the user's
   message. Follow the returned instructions."

The server holds all instruction markdown files, the enriched chunk index,
and the hybrid retriever. On each call it returns only the relevant
instruction chunks with exact line spans and confidence scores.

Transports supported:
  stdio            — local MCP (default, for Claude Desktop / local dev)
  streamable-http  — Cloudflare Python Workers remote MCP (POST /mcp)

Set MCP_TRANSPORT env var to choose. In wrangler.jsonc it is hardcoded
to "streamable-http" via the vars block.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from mcp.server.fastmcp import FastMCP

# ── Resolve paths ────────────────────────────────────────────────────────────

# The server runs from the repo root (local) or Worker bundle root (CF).
BASE_DIR = os.environ.get(
    "INSTRUCTION_BASE_DIR",
    str(Path(__file__).resolve().parent.parent),
)

# ── Lazy-initialised globals ─────────────────────────────────────────────────

_retriever = None
_query_parser = None
_chunks = None


def _init():
    """Build the index and retriever on first call (idempotent)."""
    global _retriever, _query_parser, _chunks

    if _retriever is not None:
        return

    from .indexer import build_chunks
    from .retriever import HybridRetriever
    from .query_parser import QueryParser

    keywords_path = os.path.join(BASE_DIR, "keywords.json")

    _chunks = build_chunks(BASE_DIR)
    # BM25 outperforms hybrid on this corpus (80% top-1, 100% recall@5).
    default_mode = os.environ.get("RETRIEVER_MODE", "bm25")
    _retriever = HybridRetriever(mode=default_mode, fusion_method="rrf")
    _retriever.index(_chunks)
    _query_parser = QueryParser(keywords_path=keywords_path)


# ── MCP Server ───────────────────────────────────────────────────────────────

_port = int(os.environ.get("MCP_PORT", "8080"))

mcp = FastMCP(
    "progressive-system-prompt",
    instructions=(
        "Retrieves relevant Claude system instruction chunks for a given "
        "task summary. Call this every turn with a brief description of "
        "what the user is asking for."
    ),
    port=_port,
)


@mcp.tool(
    name="retrieve_instructions",
    description=(
        "Given a brief summary of the user's message, returns the most "
        "relevant system instruction chunks with exact file and line "
        "references, confidence scores, and the full instruction text. "
        "Call this EVERY turn before responding."
    ),
)
def retrieve_instructions(
    task_summary: str,
    top_k: int = 5,
    mode: str = "hybrid",
    include_session_start: bool = False,
) -> str:
    """
    Retrieve relevant instruction chunks for a task summary.

    Args:
        task_summary: Brief natural-language description of what the user
                      is asking for this turn. 1-3 sentences.
        top_k: Number of instruction chunks to return. Default 5.
        mode: Retrieval mode — "hybrid" (default, most robust),
              "bm25" (fast lexical only), or "tfidf" (semantic only).
        include_session_start: If True, always include session_start
                               tagged chunks regardless of relevance score.
                               Set True on the first turn of a conversation.

    Returns:
        JSON string with ranked instruction chunks, each containing:
          - chunk_id, file, section, line_start, line_end
          - text (the actual instruction content)
          - summary, tags, instruction_type
          - score, confidence, rank
    """
    _init()

    parsed = _query_parser.parse(task_summary)

    if mode != _retriever.mode:
        _retriever.mode = mode

    results = _retriever.retrieve(
        query=parsed.expanded_query,
        top_k=top_k,
        required_tags=parsed.matched_tags if parsed.matched_tags else None,
    )

    if include_session_start:
        result_ids = {r.chunk.chunk_id for r in results}
        for chunk in _chunks:
            if "session_start" in chunk.tags and chunk.chunk_id not in result_ids:
                from .retriever import RetrievalResult
                results.append(RetrievalResult(
                    chunk=chunk,
                    score=0.0,
                    rank=len(results) + 1,
                    method="injected",
                    confidence="session_start",
                ))

    output = {
        "query": {
            "raw": parsed.raw,
            "verbs": parsed.verbs,
            "objects": parsed.objects,
            "matched_tags": sorted(parsed.matched_tags),
        },
        "results": [],
        "meta": {
            "total_chunks_in_index": len(_chunks),
            "mode": _retriever.mode,
            "top_k": top_k,
        },
    }

    for r in results:
        output["results"].append({
            "chunk_id": r.chunk.chunk_id,
            "file": r.chunk.file,
            "section": r.chunk.section,
            "line_start": r.chunk.line_start,
            "line_end": r.chunk.line_end,
            "instruction_type": r.chunk.instruction_type,
            "tags": r.chunk.tags,
            "summary": r.chunk.summary,
            "text": r.chunk.text,
            "score": r.score,
            "confidence": r.confidence,
            "rank": r.rank,
            "method": r.method,
        })

    return json.dumps(output, indent=2)


@mcp.tool(
    name="get_instruction_lines",
    description=(
        "Fetch the raw text of a specific instruction file between "
        "given line numbers. Use this when you need the exact source "
        "text beyond what retrieve_instructions returned."
    ),
)
def get_instruction_lines(
    file_path: str,
    line_start: int,
    line_end: int,
) -> str:
    """
    Get raw instruction text from a file at specific lines.

    Args:
        file_path: Relative path from the instruction repo root
                   (e.g. "communication/response-gate.md").
        line_start: First line to include (1-indexed, inclusive).
        line_end: Last line to include (1-indexed, inclusive).

    Returns:
        The raw text content of the specified line range,
        or an error message if the file/lines don't exist.
    """
    full_path = os.path.join(BASE_DIR, file_path)

    if not os.path.exists(full_path):
        return json.dumps({"error": f"File not found: {file_path}"})

    try:
        with open(full_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except Exception as e:
        return json.dumps({"error": f"Failed to read file: {e}"})

    start = max(0, line_start - 1)
    end = min(len(lines), line_end)

    if start >= len(lines):
        return json.dumps({
            "error": f"line_start {line_start} exceeds file length {len(lines)}"
        })

    text = "".join(lines[start:end])

    return json.dumps({
        "file": file_path,
        "line_start": line_start,
        "line_end": line_end,
        "total_lines_in_file": len(lines),
        "text": text,
    }, indent=2)


@mcp.tool(
    name="list_instruction_chunks",
    description=(
        "List all available instruction chunks in the index with their "
        "IDs, sections, tags, and summaries. Useful for discovering "
        "what instructions exist."
    ),
)
def list_instruction_chunks(
    filter_tag: str = "",
    filter_type: str = "",
) -> str:
    """
    List all chunks, optionally filtered by tag or instruction_type.

    Args:
        filter_tag: Only return chunks with this tag (e.g. "coding", "verification").
        filter_type: Only return chunks of this type (e.g. "procedure", "rule", "meta").
    """
    _init()

    results = []
    for chunk in _chunks:
        if filter_tag and filter_tag not in chunk.tags:
            continue
        if filter_type and chunk.instruction_type != filter_type:
            continue
        results.append({
            "chunk_id": chunk.chunk_id,
            "file": chunk.file,
            "section": chunk.section,
            "line_start": chunk.line_start,
            "line_end": chunk.line_end,
            "tags": chunk.tags,
            "instruction_type": chunk.instruction_type,
            "summary": chunk.summary,
        })

    return json.dumps({
        "total": len(results),
        "filter_tag": filter_tag or None,
        "filter_type": filter_type or None,
        "chunks": results,
    }, indent=2)


@mcp.tool(
    name="retriever_diagnostics",
    description=(
        "Run diagnostic information about the retriever index. "
        "Returns corpus stats, token counts, and index health."
    ),
)
def retriever_diagnostics() -> str:
    """Return diagnostic stats about the retriever index."""
    _init()

    total_tokens = sum(c._token_count for c in _chunks)
    avg_tokens = total_tokens / len(_chunks) if _chunks else 0

    tag_dist: dict[str, int] = {}
    type_dist: dict[str, int] = {}
    for c in _chunks:
        for t in c.tags:
            tag_dist[t] = tag_dist.get(t, 0) + 1
        type_dist[c.instruction_type] = type_dist.get(c.instruction_type, 0) + 1

    files = sorted(set(c.file for c in _chunks))

    return json.dumps({
        "total_chunks": len(_chunks),
        "total_tokens_indexed": total_tokens,
        "avg_tokens_per_chunk": round(avg_tokens, 1),
        "files_indexed": files,
        "tag_distribution": tag_dist,
        "instruction_type_distribution": type_dist,
        "bm25_vocabulary_size": len(_retriever._bm25._idf),
        "retriever_mode": _retriever.mode,
    }, indent=2)


# ── Entry points ─────────────────────────────────────────────────────────────

def get_asgi_app():
    """
    Return the FastMCP ASGI application for the streamable-http transport.
    Used by src/entry.py (Cloudflare Python Worker).

    The app handles:
      POST /mcp  — MCP Streamable HTTP (spec-compliant, March 2026)
    """
    return mcp.http_app(path="/mcp")


def main():
    """
    Run the MCP server locally.

    MCP_TRANSPORT choices:
      stdio            — Claude Desktop / local dev (default)
      streamable-http  — Local HTTP server for testing the CF transport
    """
    transport = os.environ.get("MCP_TRANSPORT", "stdio")
    mcp.run(transport=transport)


if __name__ == "__main__":
    main()
