/**
 * Domain ontology for chip-design / EDA / RISC-V tickets.
 *
 * Solves the "lexical gap" problem: a ticket describing "setup violation",
 * "hold slack", "STA report" is semantically about Timing, but Jira's BM25
 * text search won't match it when the user queries "timing" — because the
 * word "timing" never appears in the ticket.
 *
 * This module is a deterministic backbone: given any text, it detects which
 * domain concepts the text is about, and expands the query/ticket to include
 * all surface forms of those concepts. This guarantees recall regardless of
 * whether the LLM in the query-expander / ticket-summarizer knows the
 * domain jargon.
 *
 * Edit this file directly to add concepts for your team's domain — no UI,
 * no settings, just code. Re-loading the extension picks up changes.
 *
 * Concepts are keyed by a canonical lowercase name. Each concept has:
 *   - label:    human-readable label (for display / future UI)
 *   - surface:  list of lexical surface forms that indicate this concept
 *
 * Matching is case-insensitive. Single-word surface forms use word-boundary
 * regex (so "STA" doesn't match "stationary"). Multi-word surface forms use
 * substring match (so "setup violation" matches "setup violation in
 * PaymentService").
 */

export const DOMAIN_ONTOLOGY = {
  timing: {
    label: 'Timing',
    surface: [
      'timing', 'timing issue', 'timing violation', 'timing failure',
      'STA', 'static timing analysis',
      'setup', 'setup violation', 'setup time',
      'hold', 'hold violation', 'hold time', 'hold slack',
      'slack', 'negative slack', 'TNS', 'WNS',
      'max_delay', 'min_delay', 'cell delay', 'net delay',
      'clock skew', 'jitter', 'clock uncertainty',
      'clock tree', 'CTS', 'clock tree synthesis',
      'max frequency', 'fmax',
      'timing closure', 'timing signoff', 'timing clean',
      'SDF', 'timing arc', 'timing check',
      'metastability',
      'CDC', 'clock domain crossing', 'RDC', 'reset domain crossing',
      'cross-domain path', 'false path', 'multicycle path'
    ]
  },

  power: {
    label: 'Power',
    surface: [
      'IR drop', 'IR-drop', 'voltage drop',
      'leakage', 'leakage power', 'static power',
      'dynamic power', 'switching power', 'internal power',
      'power grid', 'PG', 'power ground',
      'electromigration', 'EM violation',
      'UPF', 'CPF', 'power intent',
      'level shifter', 'isolation cell', 'retention cell',
      'power domain', 'power gating', 'power shut-off', 'PSO',
      'low power', 'low-power'
    ]
  },

  clock: {
    label: 'Clock & Reset',
    surface: [
      'clock tree', 'CTS', 'clock tree synthesis',
      'clock gating', 'CGC', 'clock gating cell',
      'clock domain', 'CDC',
      'PLL', 'oscillator', 'crystal',
      'reset domain', 'RDC',
      'reset synchronizer', 'async reset', 'sync reset',
      'clock buffer', 'clock inverter'
    ]
  },

  routing: {
    label: 'Routing & Physical',
    surface: [
      'congestion', 'routing congestion',
      'DRC', 'design rule check', 'DRC violation',
      'LVS', 'layout vs schematic',
      'ERC', 'electrical rule check',
      'global route', 'detail route',
      'metal layer',
      'via', 'via array', 'redundant via',
      'antenna', 'antenna violation', 'antenna diode',
      'ECO', 'engineering change order',
      'DEF', 'LEF',
      'spacing violation', 'short circuit', 'open circuit'
    ]
  },

  functional: {
    label: 'Functional / Logic',
    surface: [
      'functional bug', 'logic bug', 'logic error',
      'verilog', 'systemverilog',
      'RTL', 'RTL bug',
      'simulation', 'simulate', 'sim mismatch',
      'mismatch', 'regression failure', 'regression',
      'code coverage', 'functional coverage',
      'testbench', 'UVM',
      'assertion', 'SVA', 'SystemVerilog assertion',
      'deadlock', 'race condition',
      'off-by-one', 'sign extension', 'endian'
    ]
  },

  dft: {
    label: 'DFT / Test',
    surface: [
      'DFT', 'design for test',
      'scan', 'scan chain', 'scan cell', 'scan insertion',
      'ATPG', 'test pattern',
      'BIST', 'MBIST', 'LBIST',
      'JTAG', 'boundary scan', 'TAP',
      'test compression', 'EDT',
      'stuck-at fault', 'transition fault', 'path delay fault',
      'fault coverage', 'test coverage'
    ]
  },

  physical: {
    label: 'Physical Design',
    surface: [
      'floorplan', 'floorplanning',
      'placement', 'place and route', 'P&R', 'APR',
      'physical design', 'PD signoff',
      'standard cell', 'hard macro', 'soft macro',
      'IO', 'I/O', 'pad', 'bump',
      'die size', 'core area', 'utilization',
      'power planning', 'power network'
    ]
  },

  verification: {
    label: 'Verification',
    surface: [
      'UVM', 'universal verification methodology',
      'formal', 'formal verification', 'formal proof',
      'simulation', 'functional simulation',
      'emulation', 'FPGA prototyping', 'prototyping',
      'coverage', 'coverage closure',
      'SVA', 'assertion', 'assertion-based verification',
      'regression', 'regression suite',
      'constraint random', 'directed test'
    ]
  },

  manufacturing: {
    label: 'Manufacturing / Tapeout',
    surface: [
      'GDS', 'GDSII', 'OASIS',
      'tapeout', 'tape-out', 'tape out',
      'DFM', 'design for manufacturing',
      'yield', 'yield loss',
      'litho', 'lithography', 'OPC', 'RET',
      'foundry', 'PDK', 'process node',
      'signoff', 'sign-off', 'signoff tapeout'
    ]
  },

  riscv: {
    label: 'RISC-V / ISA',
    surface: [
      'RISC-V', 'riscv', 'RV',
      'RV64', 'RV32', 'RV64G', 'RV32G',
      'ISA', 'instruction set',
      'extension', 'custom instruction', 'custom CSR',
      'CSR', 'control status register',
      'interrupt', 'exception', 'trap',
      'privilege', 'privilege mode', 'M-mode', 'S-mode', 'U-mode',
      'PMP', 'physical memory protection',
      'virtual memory', 'SVM', 'MMU',
      'debug', 'debug module', 'DebugROM'
    ]
  }
};

// Pre-compiled concept matchers: [{ key, regex }] — built once at module load.
const CONCEPT_MATCHERS = Object.entries(DOMAIN_ONTOLOGY).map(([key, concept]) => {
  const patterns = concept.surface.map((surface) => {
    const escaped = surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Multi-word surface forms: substring match (phrase may be embedded).
    // Single-word: word-boundary match so "STA" doesn't hit "stationary".
    return /\s/.test(surface) ? escaped : `\\b${escaped}\\b`;
  });
  return {
    key,
    label: concept.label,
    surface: concept.surface,
    regex: new RegExp(patterns.join('|'), 'i')
  };
});

/**
 * Detect which domain concepts appear in a text.
 *
 * @param {string} text
 * @returns {string[]} concept keys (e.g. ['timing', 'power'])
 */
export function detectConcepts(text) {
  if (!text) return [];
  const hits = new Set();
  for (const matcher of CONCEPT_MATCHERS) {
    if (matcher.regex.test(text)) {
      hits.add(matcher.key);
    }
  }
  return Array.from(hits);
}

/**
 * Expand a text (or list of tokens) into its domain concept surface forms.
 *
 * Given "P870 timing", returns:
 *   {
 *     concepts: ['timing'],
 *     expandedTerms: ['STA', 'setup', 'setup violation', 'hold', 'hold violation',
 *                     'hold time', 'hold slack', 'slack', 'negative slack', 'TNS',
 *                     'WNS', 'delay', 'max_delay', 'min_delay', ...]
 *   }
 *
 * These expanded terms are meant to be merged into the `synonyms` list of
 * the query-expander / ticket-summarizer output so the semantic channel
 * (Channel B of the hybrid search) can match tickets that use domain
 * jargon instead of the canonical concept name.
 *
 * @param {string|string[]} textOrTokens
 * @returns {{concepts: string[], expandedTerms: string[]}}
 */
export function expandWithOntology(textOrTokens) {
  const text = Array.isArray(textOrTokens)
    ? textOrTokens.join(' ')
    : (textOrTokens || '');
  const concepts = detectConcepts(text);
  const expanded = new Set();
  for (const key of concepts) {
    const matcher = CONCEPT_MATCHERS.find((m) => m.key === key);
    if (!matcher) continue;
    for (const surface of matcher.surface) {
      expanded.add(surface);
    }
  }
  return {
    concepts,
    expandedTerms: Array.from(expanded)
  };
}
