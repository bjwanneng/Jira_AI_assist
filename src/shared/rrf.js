/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Merges multiple ranked lists into one by summing 1/(k + rank_i) across
 * lists for each unique item. Standard RRF (Cormack et al., 2009) with k=60.
 *
 * Each input list must be an array of items in ranked order (best first).
 * Items are identified by `keyFn(item)` — defaults to `item.key`.
 *
 * @template T
 * @param {T[][]} rankedLists - arrays of items in ranked order
 * @param {{ k?: number, keyFn?: (item: T) => string }} [opts]
 * @returns {{ item: T, score: number, ranks: number[] }[]} merged list, sorted by score desc
 */
export function reciprocalRankFusion(rankedLists, opts = {}) {
  const k = opts.k ?? 60;
  const keyFn = opts.keyFn ?? ((item) => item?.key);

  const scores = new Map(); // key → { item, score, ranks }

  rankedLists.forEach((list) => {
    if (!Array.isArray(list)) return;
    list.forEach((item, idx) => {
      const key = keyFn(item);
      if (key == null) return;
      const rank = idx + 1;
      const contribution = 1 / (k + rank);
      const existing = scores.get(key);
      if (existing) {
        existing.score += contribution;
        existing.ranks.push(rank);
      } else {
        scores.set(key, { item, score: contribution, ranks: [rank] });
      }
    });
  });

  return Array.from(scores.values()).sort((a, b) => b.score - a.score);
}
