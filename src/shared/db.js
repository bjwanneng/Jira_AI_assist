/**
 * Minimal IndexedDB wrapper for the hybrid-search pipeline.
 *
 * Two stores:
 *   - ticketSummaries  (keyPath: issueKey)    — LLM-extracted features per ticket
 *   - queryExpansions  (keyPath: queryHash)  — LLM-expanded free-form queries
 *
 * Each record carries a `schemaVersion` field. Reads with a stale version
 * return null so the caller re-runs the LLM and overwrites — that's our
 * only "migration" path today.
 *
 * Service workers can be killed mid-write; idempotent puts keyed by issueKey
 * make that safe. All methods are async and reject on IndexedDB errors.
 */

const DB_NAME = 'jira_ai_assist';
const DB_VERSION = 1;
const STORE_SUMMARIES = 'ticketSummaries';
const STORE_EXPANSIONS = 'queryExpansions';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SUMMARIES)) {
        db.createObjectStore(STORE_SUMMARIES, { keyPath: 'issueKey' });
      }
      if (!db.objectStoreNames.contains(STORE_EXPANSIONS)) {
        db.createObjectStore(STORE_EXPANSIONS, { keyPath: 'queryHash' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
  });
  return dbPromise;
}

function txGet(storeName, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function txPut(storeName, value) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  }));
}

/**
 * Read a cached ticket summary. Returns null if missing or stale schema.
 * @param {string} issueKey
 * @param {number} expectedSchemaVersion
 */
export async function getSummary(issueKey, expectedSchemaVersion) {
  try {
    const rec = await txGet(STORE_SUMMARIES, issueKey);
    if (!rec) return null;
    if (rec.schemaVersion !== expectedSchemaVersion) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Persist a ticket summary. Overwrites any existing record for the same key.
 * @param {string} issueKey
 * @param {object} summary
 * @param {number} schemaVersion
 */
export async function setSummary(issueKey, summary, schemaVersion) {
  try {
    await txPut(STORE_SUMMARIES, {
      issueKey,
      summary,
      schemaVersion,
      updatedAt: Date.now()
    });
  } catch {
    // Cache writes are best-effort — failure shouldn't break search.
  }
}

/**
 * Read a cached query expansion. Returns null if missing or stale schema.
 * @param {string} queryHash
 * @param {number} expectedSchemaVersion
 */
export async function getExpandedQuery(queryHash, expectedSchemaVersion) {
  try {
    const rec = await txGet(STORE_EXPANSIONS, queryHash);
    if (!rec) return null;
    if (rec.schemaVersion !== expectedSchemaVersion) return null;
    return rec;
  } catch {
    return null;
  }
}

/**
 * Persist a query expansion.
 * @param {string} queryHash
 * @param {object} expansion
 * @param {number} schemaVersion
 */
export async function setExpandedQuery(queryHash, expansion, schemaVersion) {
  try {
    await txPut(STORE_EXPANSIONS, {
      queryHash,
      expansion,
      schemaVersion,
      updatedAt: Date.now()
    });
  } catch {
    // best-effort
  }
}

/**
 * SHA-256 hash of a query string, returned as hex. Used as the cache key
 * for query expansions. Uses SubtleCrypto (available in service workers).
 * @param {string} query
 * @returns {Promise<string>}
 */
export async function hashQuery(query) {
  const data = new TextEncoder().encode(query || '');
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
