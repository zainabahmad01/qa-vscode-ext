/**
 * Local storage module for QA Super Agent.
 *
 * Persists analysis results as JSON files inside VS Code's global storage
 * directory (~/.vscode/extensions/<publisher>.<name>-<version>/storage).
 * All operations are synchronous-friendly and work fully offline.
 */

const fs   = require('fs');
const path = require('path');

const RESULTS_DIR = 'qa-results';

// ── Internal helpers ──────────────────────────────────────────────────────────

function resultsDir(context) {
  const base = context.globalStorageUri.fsPath;
  return path.join(base, RESULTS_DIR);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function resultFilePath(context, id) {
  return path.join(resultsDir(context), `${id}.json`);
}

function generateId() {
  const now = new Date();
  const datePart = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 7);
  return `${datePart}-${rand}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save a QA analysis result locally.
 * Returns the generated record (result + metadata).
 */
function saveResult(context, result, label) {
  const dir = resultsDir(context);
  ensureDir(dir);

  const id = generateId();
  const record = {
    id,
    label: label || `Analysis ${new Date().toLocaleString()}`,
    savedAt: new Date().toISOString(),
    result,
  };

  fs.writeFileSync(resultFilePath(context, id), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

/**
 * Load all saved result metadata (id, label, savedAt) — without the full payload.
 * Returns newest first.
 */
function listResults(context) {
  const dir = resultsDir(context);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const rec = JSON.parse(raw);
        return { id: rec.id, label: rec.label, savedAt: rec.savedAt };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

/**
 * Load a single result record by id. Returns null if not found.
 */
function loadResult(context, id) {
  const fpath = resultFilePath(context, id);
  if (!fs.existsSync(fpath)) return null;
  try {
    return JSON.parse(fs.readFileSync(fpath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Delete a saved result by id. Returns true if deleted, false if not found.
 */
function deleteResult(context, id) {
  const fpath = resultFilePath(context, id);
  if (!fs.existsSync(fpath)) return false;
  fs.unlinkSync(fpath);
  return true;
}

/**
 * Return the storage directory path (useful for diagnostics / data sharing).
 */
function getStoragePath(context) {
  return resultsDir(context);
}

module.exports = {
  saveResult,
  listResults,
  loadResult,
  deleteResult,
  getStoragePath,
};
