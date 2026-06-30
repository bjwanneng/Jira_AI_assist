/**
 * Parse the first JSON object or array from an LLM response.
 *
 * Handles both fenced (```json ... ```) and bare {...} / [...] shapes.
 * Used by the search pipeline (summarizer, expander, reranker) where the
 * LLM is asked to emit structured JSON without going through the
 * tool_calls convention in prompt-builder.js.
 *
 * @param {string} content - raw LLM response text
 * @returns {object|array|null} parsed JSON, or null if no valid JSON found
 */
export function parseLlmJson(content) {
  if (!content) return null;

  // 1. Preferred: fenced ```json ... ``` block.
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const parsed = safeParse(fenced[1]);
    if (parsed !== null) return parsed;
  }

  // 2. Bare object/array: greedily match the largest balanced {...} or [...].
  //    We try the outermost match first because nested objects may also parse
  //    on their own.
  const start = content.search(/[{[]/);
  if (start === -1) return null;

  for (let end = content.length; end > start; end--) {
    const slice = content.slice(start, end);
    const parsed = safeParse(slice);
    if (parsed !== null) return parsed;
  }

  return null;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
