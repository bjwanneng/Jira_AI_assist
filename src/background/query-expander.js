/**
 * Free-form query expansion for `search_jira` (no source ticket).
 *
 * Implements Multi-Query Retrieval: a broad query like "EHT PD tickets" is
 * decomposed into multiple sub-queries (timing, SDC, DFT, UPF, synthesis...),
 * each with its own primaryTerms + synonyms. This dramatically improves recall
 * for broad domain queries where a single set of keywords can't cover all
 * sub-areas.
 *
 * Output schema (v2 - sub-query decomposition):
 *   {
 *     subQueries: [
 *       { focus: "timing", primaryTerms: [...], synonyms: [...] },
 *       { focus: "SDC",    primaryTerms: [...], synonyms: [...] },
 *       ...
 *     ],
 *     // v1 fields preserved for backward compatibility (merged from all sub-queries):
 *     primaryTerms: [...], synonyms: [...], concepts: [...]
 *   }
 *
 * Cached by SHA-256(query) in IndexedDB so repeat queries are free.
 */

import { getExpandedQuery, setExpandedQuery, hashQuery } from '../shared/db.js';
import { QUERY_EXPANSION_SCHEMA_VERSION } from '../shared/constants.js';
import { parseLlmJson } from '../shared/llm-json.js';
import { expandWithOntology } from '../shared/ontology.js';

const EXPANDER_SYSTEM_PROMPT = `You expand a search query for Jira full-text search in a chip-design / RISC-V / EDA support context.

Your task: decompose the query into focused sub-queries, each targeting a distinct technical sub-domain. This ensures broad coverage when the user asks about a wide topic like "PD" (Physical Design) which spans timing, SDC, DFT, UPF, synthesis, and more.

Domain abbreviations:
  PD = Physical Design (floorplan, placement, P&R, routing, timing closure, ECO)
  STA = Static Timing Analysis (setup, hold, slack, TNS, WNS)
  CDC = Clock Domain Crossing (metastability, async)
  DFT = Design for Test (scan, ATPG, BIST, JTAG)
  SDC = Synopsys Design Constraints (create_clock, set_max_delay, false_path)
  UPF = Unified Power Format (power domain, level shifter, isolation)
  TRNG = True Random Number Generator (ring oscillator, entropy, seed)
  APR = Automatic Place and Route
  CTS = Clock Tree Synthesis
  IR = IR Drop (voltage drop, power grid)
  EM = Electromigration
  RTL = Register Transfer Level (Verilog, SystemVerilog)
  IP = Intellectual Property core (BEU, CLINT, PLIC, Debug, etc.)
  MMIO = Memory-Mapped I/O
  SoC = System on Chip

Customer names (NOT project keys): EHT, AMD, ESWIN, Bytedance, Lanxin, Lisuan, Semiotics, Siliconwaves.
When the query mentions a customer name, include it in primaryTerms so Jira's text search matches the [EHT] or [Customer] tag in ticket summaries.

Return ONLY a JSON object (no prose, no markdown fence):
{
  "mandatoryTerms": ["customer or entity names that MUST appear in every result, e.g. 'EHT'"],
  "subQueries": [
    {
      "focus": "short label for this sub-domain, e.g. 'timing' or 'SDC'",
      "primaryTerms": ["3-6 precise terms likely in the ticket"],
      "synonyms": ["3-6 synonyms/paraphrases for broad recall"]
    }
  ]
}

Rules:
- mandatoryTerms: extract customer/entity names (EHT, AMD, ESWIN, etc.) from the query. These become AND filters so every result MUST contain them. Leave empty if no customer name is present.
- Produce 1-6 sub-queries depending on query breadth. A narrow query ("BEU interrupt") = 1 sub-query. A broad query ("EHT PD tickets") = 4-6 sub-queries covering distinct sub-domains.
- Each term 2-32 chars. Skip stop words.
- Do NOT put customer names in sub-query primaryTerms - put them ONLY in mandatoryTerms.
- Do NOT duplicate the same term across many sub-queries - each sub-query should have distinct keywords.`;

function asStringArr(v, max = 10) {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : String(x)))
    .filter((s) => s.length >= 2 && s.length <= 32)
    .slice(0, max);
}

function normalizeSubQueries(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // v2 format: subQueries array
  if (Array.isArray(parsed.subQueries) && parsed.subQueries.length > 0) {
    const mandatoryTerms = asStringArr(parsed.mandatoryTerms, 5);
    const subs = parsed.subQueries
      .map((sq) => ({
        focus: typeof sq.focus === 'string' ? sq.focus.slice(0, 40) : '',
        primaryTerms: asStringArr(sq.primaryTerms, 8),
        synonyms: asStringArr(sq.synonyms, 8)
      }))
      .filter((sq) => sq.primaryTerms.length > 0 || sq.synonyms.length > 0);
    if (subs.length === 0) return null;
    return { mandatoryTerms, subQueries: subs };
  }

  // v1 format: flat primaryTerms + synonyms (backward compat)
  const primaryTerms = asStringArr(parsed.primaryTerms);
  const synonyms = asStringArr(parsed.synonyms);
  if (primaryTerms.length === 0 && synonyms.length === 0) return null;
  return {
    subQueries: [{ focus: 'general', primaryTerms, synonyms }]
  };
}

/**
 * Enrich each sub-query with ontology surface forms. The ontology is a
 * deterministic backbone that guarantees domain synonyms regardless of
 * whether the LLM knew the chip-design jargon.
 */
function enrichWithOntology(expansion, query) {
  if (!expansion?.subQueries) return expansion;

  const allTerms = [
    query,
    ...expansion.subQueries.flatMap((sq) => [...sq.primaryTerms, ...sq.synonyms])
  ];
  const ontologyHit = expandWithOntology(allTerms);
  expansion.concepts = ontologyHit.concepts;

  // Merge ontology expanded terms into each sub-query whose focus matches
  // a detected concept. This adds deterministic surface forms the LLM may
  // have missed.
  for (const sq of expansion.subQueries) {
    const sqHit = expandWithOntology([sq.focus, ...sq.primaryTerms, ...sq.synonyms]);
    if (sqHit.expandedTerms.length > 0) {
      const merged = new Set([...sq.synonyms, ...sqHit.expandedTerms]);
      sq.synonyms = Array.from(merged)
        .filter((s) => s.length >= 2 && s.length <= 32)
        .slice(0, 14);
    }
  }

  // Build backward-compatible flat fields (merged from all sub-queries).
  const allPrimary = new Set();
  const allSynonyms = new Set();
  for (const sq of expansion.subQueries) {
    sq.primaryTerms.forEach((t) => allPrimary.add(t));
    sq.synonyms.forEach((t) => allSynonyms.add(t));
  }
  expansion.primaryTerms = Array.from(allPrimary).slice(0, 20);
  expansion.synonyms = Array.from(allSynonyms).slice(0, 30);

  return expansion;
}

/**
 * Expand a free-form query into sub-queries with primaryTerms + synonyms.
 * Returns null on failure.
 *
 * @param {string} query
 * @param {object} llm - LlmClient instance
 * @returns {Promise<object|null>}
 */
export async function expandQuery(query, llm) {
  if (!llm || !query) return null;

  try {
    const response = await llm.chatCheap([
      { role: 'system', content: EXPANDER_SYSTEM_PROMPT },
      { role: 'user', content: `Query: ${query}\n\nReturn the JSON now.` }
    ]);
    const normalized = normalizeSubQueries(parseLlmJson(response?.content || ''));
    if (!normalized) return null;
    const enriched = enrichWithOntology(normalized, query);
    const hash = await hashQuery(query);
    await setExpandedQuery(hash, enriched, QUERY_EXPANSION_SCHEMA_VERSION);
    return enriched;
  } catch (err) {
    console.warn('[query-expander] failed for', query, err.message);
    return null;
  }
}

/**
 * Get the cached expansion for a query, or expand it now and cache the result.
 * Returns null if both cache miss and expansion fail.
 *
 * @param {string} query
 * @param {object} llm - LlmClient instance
 * @returns {Promise<object|null>}
 */
export async function getOrExpand(query, llm) {
  if (!query) return null;

  const hash = await hashQuery(query);
  const cached = await getExpandedQuery(hash, QUERY_EXPANSION_SCHEMA_VERSION);
  if (cached?.expansion) return cached.expansion;

  return expandQuery(query, llm);
}
