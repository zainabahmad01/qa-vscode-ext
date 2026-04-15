/**
 * Data sharing module for QA Super Agent.
 *
 * Provides export and import of QA analysis results as portable JSON files,
 * enabling sharing between users or machines with no internet required.
 * Uses VS Code's native save/open dialogs for file selection.
 */

const fs      = require('fs');
const vscode  = require('vscode');

const SHARE_VERSION = '1.0';
const FILE_FILTER   = { 'QA Super Agent Results (*.qa.json)': ['qa.json'], 'JSON': ['json'] };

// ── Internal ──────────────────────────────────────────────────────────────────

function makeShareEnvelope(record) {
  return {
    _qaShareVersion: SHARE_VERSION,
    _exportedAt: new Date().toISOString(),
    id: record.id,
    label: record.label,
    savedAt: record.savedAt,
    result: record.result,
  };
}

function validateEnvelope(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.result || typeof obj.result !== 'object') return false;
  return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Export a result record to a user-chosen file.
 * Shows a native Save dialog. Returns the chosen path, or null if cancelled.
 */
async function exportResult(record) {
  const defaultName = (record.label || 'qa-result')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .slice(0, 50) + '.qa.json';

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(defaultName),
    filters: FILE_FILTER,
    title: 'Export QA Result',
    saveLabel: 'Export',
  });

  if (!uri) return null;

  const envelope = makeShareEnvelope(record);
  fs.writeFileSync(uri.fsPath, JSON.stringify(envelope, null, 2), 'utf8');

  vscode.window.showInformationMessage(
    `QA Super Agent: Result exported to ${uri.fsPath}`
  );
  return uri.fsPath;
}

/**
 * Import a result record from a user-chosen file.
 * Shows a native Open dialog. Returns the parsed record, or null if cancelled/invalid.
 */
async function importResult() {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: FILE_FILTER,
    title: 'Import QA Result',
    openLabel: 'Import',
  });

  if (!uris || uris.length === 0) return null;

  let envelope;
  try {
    const raw = fs.readFileSync(uris[0].fsPath, 'utf8');
    envelope = JSON.parse(raw);
  } catch {
    vscode.window.showErrorMessage('QA Super Agent: Could not read the selected file.');
    return null;
  }

  if (!validateEnvelope(envelope)) {
    vscode.window.showErrorMessage(
      'QA Super Agent: File does not appear to be a valid QA Super Agent export.'
    );
    return null;
  }

  return {
    id: envelope.id || ('imported-' + Date.now()),
    label: envelope.label || 'Imported Result',
    savedAt: envelope.savedAt || envelope._exportedAt || new Date().toISOString(),
    result: envelope.result,
    importedFrom: uris[0].fsPath,
  };
}

module.exports = {
  exportResult,
  importResult,
};
