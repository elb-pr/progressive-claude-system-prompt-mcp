// System Prompt Retrieval — MCP Worker
// Cloudflare Worker — structured JSON instruction files, no hardcoded content.
// HybridRetriever: BM25 + TF-IDF cosine + RRF/convex fusion + tag boosting
// QueryParser: verb/object extraction + keyword→tag inference
// Transport: MCP Streamable HTTP on POST /mcp

// ── JSON imports ──────────────────────────────────────────────────────────────
import KEYWORD_DATA from './keywords.json';

import _collaboration       from './communication/collaboration.json';
import _outputStandards     from './communication/output-standards.json';
import _persistentProblems  from './communication/persistent-problems.json';
import _responseGate        from './communication/response-gate.json';
import _filesArtifacts      from './operations/files-artifacts.json';
import _sessionContext       from './operations/session-context.json';
import _claudePersonalNotes from './project-management/claude-personal-notes.json';
import _plansTasksDecisions from './project-management/plans-tasks-decisions.json';
import _sessionStart        from './project-management/session-start.json';
import _decisionsTemplate   from './project-management/templates/decisions-date-label.json';
import _plansTemplate       from './project-management/templates/plans-date-label.json';
import _taskTemplate        from './project-management/templates/task-date-label.json';

// ── Build CHUNKS by flattening all imported instruction arrays ─────────────────
// Each JSON file is an array of chunk objects with structured fields.
// BM25/TF-IDF tokenises over summary + keywords + all string values in the chunk.

function extractStrings(obj) {
  if (typeof obj === 'string') return [obj];
  if (Array.isArray(obj)) return obj.flatMap(extractStrings);
  if (obj && typeof obj === 'object') return Object.values(obj).flatMap(extractStrings);
  return [];
}

const CHUNKS = [
  ..._collaboration,
  ..._outputStandards,
  ..._persistentProblems,
  ..._responseGate,
  ..._filesArtifacts,
  ..._sessionContext,
  ..._claudePersonalNotes,
  ..._plansTasksDecisions,
  ..._sessionStart,
  ..._decisionsTemplate,
  ..._plansTemplate,
  ..._taskTemplate,
].map(chunk => ({
  ...chunk,
  // Synthesise a flat text field for BM25/TF-IDF from all string values
  text: extractStrings(chunk).join(' '),
  // Expose ls/le as 0 (line ranges no longer apply — content is in the JSON)
  ls: 0, le: 0,
}));

// ── Keyword categories for QueryParser tag inference ──────────────────────────
const KEYWORD_CATEGORIES = KEYWORD_DATA.categories;

// ── Stopwords ────────────────────────────────────────────────────────────────
const STOP = new Set("a an the is are was were be been being have has had do does did will would shall should may might can could of in to for on with at by from as into through during before after above below between out off over under again further then once here there when where why how all each every both few more most other some such no nor not only own same so than too very and but if or because until while about against it its this that these those i me my we our you your he him his she her they them their what which who whom".split(" "));

function tokenise(text) {
  return text.toLowerCase().match(/[a-z0-9_]+/g)?.filter(t => !STOP.has(t) && t.length > 1) || [];
}

// ── BM25 ─────────────────────────────────────────────────────────────────────
class BM25 {
  constructor(k1 = 1.5, b = 0.75) { this.k1 = k1; this.b = b; this.docs = []; this.idf = {}; this.avgDl = 0; }

  index(chunks) {
    this.docs = chunks.map(c => {
      const tokens = tokenise(`${c.text} ${c.summary} ${(c.keywords||[]).join(" ")}`);
      const freq = {};
      for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
      c._tokenCount = tokens.length;
      c._freq = freq;
      return { chunk: c, freq, len: tokens.length };
    });
    const n = this.docs.length;
    this.avgDl = this.docs.reduce((s, d) => s + d.len, 0) / (n || 1);
    const df = {};
    for (const d of this.docs) for (const t of new Set(Object.keys(d.freq))) df[t] = (df[t] || 0) + 1;
    for (const [t, f] of Object.entries(df)) this.idf[t] = Math.log((n - f + 0.5) / (f + 0.5) + 1);
  }

  score(queryTokens) {
    const scores = this.docs.map((d, i) => {
      let s = 0;
      for (const qt of queryTokens) {
        if (!this.idf[qt]) continue;
        const tf = d.freq[qt] || 0;
        s += this.idf[qt] * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * d.len / this.avgDl));
      }
      return [i, s];
    });
    return scores.sort((a, b) => b[1] - a[1]);
  }
}

// ── TF-IDF Semantic ───────────────────────────────────────────────────────────
class TFIDFSemantic {
  constructor() { this.idf = {}; this.docs = []; }

  index(chunks) {
    this.docs = chunks;
    const n = chunks.length;
    const df = {};
    for (const c of chunks) {
      const tokens = new Set(tokenise(`${c.text} ${c.summary} ${(c.keywords||[]).join(" ")}`));
      for (const t of tokens) df[t] = (df[t] || 0) + 1;
    }
    this.idf = {};
    for (const [t, f] of Object.entries(df)) this.idf[t] = Math.log(n / f) + 1;

    for (const c of chunks) {
      const tokens = tokenise(`${c.text} ${c.summary} ${(c.keywords||[]).join(" ")}`);
      const tf = {};
      for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
      const total = tokens.length || 1;
      const vec = {};
      for (const [t, count] of Object.entries(tf)) {
        if (this.idf[t]) vec[t] = (count / total) * this.idf[t];
      }
      const norm = Math.sqrt(Object.values(vec).reduce((s, v) => s + v * v, 0)) || 1;
      c._tfidf = {};
      for (const [t, v] of Object.entries(vec)) c._tfidf[t] = v / norm;
    }
  }

  score(queryTokens) {
    const tf = {};
    for (const t of queryTokens) tf[t] = (tf[t] || 0) + 1;
    const total = queryTokens.length || 1;
    const qVec = {};
    for (const [t, count] of Object.entries(tf)) {
      if (this.idf[t]) qVec[t] = (count / total) * this.idf[t];
    }
    const qNorm = Math.sqrt(Object.values(qVec).reduce((s, v) => s + v * v, 0)) || 1;
    for (const t of Object.keys(qVec)) qVec[t] /= qNorm;

    return this.docs.map((c, i) => {
      const allTerms = new Set([...Object.keys(qVec), ...Object.keys(c._tfidf || {})]);
      let dot = 0;
      for (const t of allTerms) dot += (qVec[t] || 0) * (c._tfidf?.[t] || 0);
      return [i, dot];
    }).sort((a, b) => b[1] - a[1]);
  }
}

// ── Fusion ────────────────────────────────────────────────────────────────────
function rrfFusion(rankedLists, k = 60) {
  const scores = {};
  for (const ranked of rankedLists) {
    ranked.forEach(([idx], rank) => {
      scores[idx] = (scores[idx] || 0) + 1 / (k + rank + 1);
    });
  }
  return Object.entries(scores).map(([i, s]) => [+i, s]).sort((a, b) => b[1] - a[1]);
}

function convexFusion(lexical, semantic, alpha = 0.6) {
  function normalise(scores) {
    if (!scores.length) return {};
    const vals = scores.map(([, s]) => s);
    const min = Math.min(...vals), max = Math.max(...vals);
    const rng = max - min || 1;
    const out = {};
    for (const [i, s] of scores) out[i] = (s - min) / rng;
    return out;
  }
  const nLex = normalise(lexical), nSem = normalise(semantic);
  const all = new Set([...Object.keys(nLex), ...Object.keys(nSem)].map(Number));
  const combined = {};
  for (const i of all) combined[i] = alpha * (nLex[i] || 0) + (1 - alpha) * (nSem[i] || 0);
  return Object.entries(combined).map(([i, s]) => [+i, s]).sort((a, b) => b[1] - a[1]);
}

// ── Confidence ────────────────────────────────────────────────────────────────
function classifyConfidence(score, maxScore) {
  if (maxScore <= 0) return "uncertain";
  const r = score / maxScore;
  if (r >= 0.7) return "high";
  if (r >= 0.4) return "medium";
  if (r >= 0.15) return "low";
  return "uncertain";
}

// ── Tag Boosting ──────────────────────────────────────────────────────────────
function applyTagBoost(scores, chunks, requiredTags, boostFactor = 1.3) {
  if (!requiredTags || !requiredTags.size) return scores;
  return scores.map(([idx, score]) => {
    const overlap = chunks[idx].tags.filter(t => requiredTags.has(t)).length;
    return [idx, overlap > 0 ? score * Math.pow(boostFactor, overlap) : score];
  }).sort((a, b) => b[1] - a[1]);
}

// ── Action Verbs & Object Nouns (from query_parser.py) ────────────────────────
const ACTION_VERBS = new Set(["verify","check","validate","test","confirm","assert","create","build","generate","write","produce","draft","edit","modify","update","change","fix","patch","refactor","read","extract","parse","inspect","examine","review","plan","design","architect","structure","organise","organize","deploy","push","publish","release","ship","compare","evaluate","score","rank","benchmark","search","find","retrieve","query","log","record","track","document","note","start","begin","init","bootstrap","setup","complete","finish","close","done","wrap","escalate","surface","flag","warn","alert","diagram","visualise","visualize","chart","draw"]);
const OBJECT_NOUNS = new Set(["file","files","document","documents","code","script","task","tasks","plan","plans","decision","decisions","skill","skills","tool","tools","mcp","server","repo","repository","github","git","test","tests","suite","spec","prompt","instruction","instructions","notes","log","session","context","diagram","chart","output","artifact","artefact","linear","ticktick","board","error","bug","issue","warning"]);

// ── QueryParser ───────────────────────────────────────────────────────────────
function parseQuery(taskSummary) {
  const raw = taskSummary.trim();
  const tokens = (raw.toLowerCase().match(/[a-z0-9_./-]+/g) || []);
  const tokenSet = new Set(tokens);

  // Build bigrams
  const bigrams = new Set();
  for (let i = 0; i < tokens.length - 1; i++) bigrams.add(`${tokens[i]} ${tokens[i+1]}`);

  const verbs = tokens.filter(t => ACTION_VERBS.has(t));
  const objects = tokens.filter(t => OBJECT_NOUNS.has(t));
  const constraints = tokens.filter(t => !ACTION_VERBS.has(t) && !OBJECT_NOUNS.has(t) && !STOP.has(t) && t.length > 2);

  // Tag inference from KEYWORD_CATEGORIES
  const matchedTags = new Set();
  for (const [, cat] of Object.entries(KEYWORD_CATEGORIES)) {
    const catKws = new Set(cat.keywords.map(k => k.toLowerCase()));
    const hit = [...tokenSet].some(t => catKws.has(t)) || [...bigrams].some(b => catKws.has(b));
    if (hit) for (const tag of cat.maps_to_tags) matchedTags.add(tag);
  }

  return { raw, tokens, verbs, objects, constraints, matchedTags, expandedQuery: raw };
}

// ── HybridRetriever ───────────────────────────────────────────────────────────
class HybridRetriever {
  constructor() {
    this.bm25 = new BM25();
    this.tfidf = new TFIDFSemantic();
    this.chunks = [];
    this._indexed = false;
  }

  index(chunks) {
    this.chunks = chunks;
    this.bm25.index(chunks);
    this.tfidf.index(chunks);
    this._indexed = true;
  }

  retrieve(query, topK = 5, mode = "hybrid", fusionMethod = "rrf", requiredTags = null) {
    const qTokens = tokenise(query);
    if (!qTokens.length) return [];

    let rawScores, method;
    if (mode === "bm25") {
      rawScores = this.bm25.score(qTokens);
      method = "bm25";
    } else if (mode === "tfidf") {
      rawScores = this.tfidf.score(qTokens);
      method = "tfidf";
    } else {
      const bScores = this.bm25.score(qTokens);
      const tScores = this.tfidf.score(qTokens);
      rawScores = fusionMethod === "convex"
        ? convexFusion(bScores, tScores, 0.6)
        : rrfFusion([bScores, tScores]);
      method = "hybrid";
    }

    if (requiredTags && requiredTags.size) {
      rawScores = applyTagBoost(rawScores, this.chunks, requiredTags);
    }

    const top = rawScores.slice(0, topK).filter(([, s]) => s > 0);
    if (!top.length) return [];
    const maxScore = top[0][1];

    return top.map(([idx, score], rank) => ({
      chunk: this.chunks[idx],
      score: Math.round(score * 1e6) / 1e6,
      rank: rank + 1,
      method,
      confidence: classifyConfidence(score, maxScore),
    }));
  }
}

// ── Build index at module load ────────────────────────────────────────────────
const retriever = new HybridRetriever();
retriever.index(CHUNKS);

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "retrieve_instructions",
    description: "Given a brief summary of the user's message, returns the relevant instruction texts to follow. Call this EVERY turn before responding.",
    inputSchema: {
      type: "object",
      properties: {
        task_summary: { type: "string", description: "Brief 1-3 sentence description of what the user is asking for." },
        top_k: { type: "integer", description: "Number of chunks to return. Default 5.", default: 5 },
        mode: { type: "string", description: "Retrieval mode: bm25 | tfidf | hybrid. Default hybrid.", default: "hybrid", enum: ["bm25","tfidf","hybrid"] },
        fusion_method: { type: "string", description: "Fusion method when mode=hybrid: rrf | convex. Default rrf.", default: "rrf", enum: ["rrf","convex"] },
        include_session_start: { type: "boolean", description: "If true, always include session_start chunks. Set true on first turn.", default: false },
        debug: { type: "boolean", description: "If true, return full metadata (scores, ranks, file refs). Default false.", default: false },
      },
      required: ["task_summary"],
    },
  },
  {
    name: "get_instruction_lines",
    description: "Fetch the raw text of a specific instruction file between given line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Relative path from repo root." },
        line_start: { type: "integer", description: "First line, 1-indexed inclusive." },
        line_end: { type: "integer", description: "Last line, 1-indexed inclusive." },
      },
      required: ["file_path", "line_start", "line_end"],
    },
  },
  {
    name: "list_instruction_chunks",
    description: "List all available instruction chunks with IDs, sections, tags, and summaries.",
    inputSchema: {
      type: "object",
      properties: {
        filter_tag: { type: "string", description: "Only chunks with this tag.", default: "" },
        filter_type: { type: "string", description: "Only chunks of this instruction_type.", default: "" },
      },
    },
  },
  {
    name: "retriever_diagnostics",
    description: "Returns corpus stats, token counts, vocabulary size, and index health.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────
function handleTool(name, args) {
  if (name === "retrieve_instructions") {
    const topK = args.top_k || 5;
    const mode = args.mode || "hybrid";
    const fusionMethod = args.fusion_method || "rrf";

    const parsed = parseQuery(args.task_summary);

    let results = retriever.retrieve(
      parsed.expandedQuery,
      topK,
      mode,
      fusionMethod,
      parsed.matchedTags.size ? parsed.matchedTags : null
    );

    if (args.include_session_start) {
      const ids = new Set(results.map(r => r.chunk.id));
      for (const c of CHUNKS) {
        if (c.tags.includes("session_start") && !ids.has(c.id)) {
          results.push({ chunk: c, score: 0, rank: results.length + 1, method: "injected", confidence: "session_start" });
        }
      }
    }

    if (args.debug === true) {
      return {
        query: {
          raw: parsed.raw,
          verbs: parsed.verbs,
          objects: parsed.objects,
          constraints: parsed.constraints,
          matched_tags: [...parsed.matchedTags].sort(),
        },
        results: results.map(r => ({
          chunk_id: r.chunk.id,
          file: r.chunk.file,
          section: r.chunk.section,
          line_start: r.chunk.ls,
          line_end: r.chunk.le,
          instruction_type: r.chunk.type,
          tags: r.chunk.tags,
          summary: r.chunk.summary,
          text: r.chunk.text,
          score: r.score,
          confidence: r.confidence,
          rank: r.rank,
          method: r.method,
        })),
        meta: {
          total_chunks_in_index: CHUNKS.length,
          mode,
          fusion_method: mode === "hybrid" ? fusionMethod : null,
          top_k: topK,
        },
      };
    }

    return { instructions: results.map(r => r.chunk.text) };
  }

  if (name === "get_instruction_lines") {
    const chunk = CHUNKS.find(c => c.id === args.file_path || c.file === args.file_path);
    if (!chunk) return { error: `No chunk found for: ${args.file_path}` };
    const { text, ...structured } = chunk;
    return structured;
  }

  if (name === "list_instruction_chunks") {
    let filtered = CHUNKS;
    if (args.filter_tag) filtered = filtered.filter(c => c.tags.includes(args.filter_tag));
    if (args.filter_type) filtered = filtered.filter(c => c.type === args.filter_type);
    return {
      total: filtered.length,
      filter_tag: args.filter_tag || null,
      filter_type: args.filter_type || null,
      chunks: filtered.map(c => ({
        chunk_id: c.id, file: c.file, section: c.section,
        line_start: c.ls, line_end: c.le,
        tags: c.tags, instruction_type: c.type, summary: c.summary,
      })),
    };
  }

  if (name === "retriever_diagnostics") {
    const tagDist = {}, typeDist = {};
    let totalTokens = 0;
    for (const c of CHUNKS) {
      for (const t of c.tags) tagDist[t] = (tagDist[t] || 0) + 1;
      typeDist[c.type] = (typeDist[c.type] || 0) + 1;
      totalTokens += (c._tokenCount || 0);
    }
    const avgTokens = totalTokens / (CHUNKS.length || 1);
    return {
      total_chunks: CHUNKS.length,
      total_tokens_indexed: totalTokens,
      avg_tokens_per_chunk: Math.round(avgTokens * 10) / 10,
      bm25_vocabulary_size: Object.keys(retriever.bm25.idf).length,
      tfidf_vocabulary_size: Object.keys(retriever.tfidf.idf).length,
      retriever_mode: "hybrid (default)",
      tag_distribution: tagDist,
      instruction_type_distribution: typeDist,
      files_indexed: [...new Set(CHUNKS.map(c => c.file))].sort(),
    };
  }

  return { error: `Unknown tool: ${name}` };
}

// ── MCP JSON-RPC ──────────────────────────────────────────────────────────────
function jsonrpc(id, result) { return { jsonrpc: "2.0", id, result }; }
function jsonrpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

function handleMessage(msg) {
  const { method, id, params } = msg;
  if (!id && method === "notifications/initialized") return null;

  if (method === "initialize") {
    return jsonrpc(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "progressive-system-prompt", version: "2.0.0" },
    });
  }
  if (method === "tools/list") return jsonrpc(id, { tools: TOOLS });
  if (method === "tools/call") {
    const result = handleTool(params?.name, params?.arguments || {});
    return jsonrpc(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
  }
  if (method === "ping") return jsonrpc(id, {});
  return jsonrpcError(id, -32601, `Method not found: ${method}`);
}

// ── Worker fetch handler ──────────────────────────────────────────────────────
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response(JSON.stringify({
        status: "ok", transport: "streamable-http", endpoint: "/mcp",
        chunks: CHUNKS.length, version: "2.0.0",
        modes: ["bm25", "tfidf", "hybrid"],
        fusion_methods: ["rrf", "convex"],
      }), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname !== "/mcp") {
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }

    if (request.method === "GET") {
      return new Response(JSON.stringify({ error: "Use POST for MCP streamable-http" }), { status: 405, headers: { "content-type": "application/json" } });
    }

    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    let body;
    try { body = await request.json(); } catch {
      return new Response(JSON.stringify(jsonrpcError(null, -32700, "Parse error")), { status: 400, headers: { "content-type": "application/json" } });
    }

    const messages = Array.isArray(body) ? body : [body];
    const responses = messages.map(handleMessage).filter(Boolean);
    const out = responses.length === 1 ? responses[0] : responses;
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  },
};
