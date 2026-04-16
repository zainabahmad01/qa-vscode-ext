const vscode      = require('vscode');
const https       = require('https');
const http        = require('http');
const path        = require('path');
const fs          = require('fs');
const localStorage  = require('./src/localStorage');
const dataSharing   = require('./src/dataSharing');

// ── Constants ────────────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'build', 'dist', 'vendor', '.dart_tool',
  '.idea', '.vscode', '__pycache__', '.gradle', 'ios', 'android',
  'macos', 'windows', 'linux', 'Pods', 'coverage', '.pub-cache',
  'test', 'tests', 'integration_test', '__tests__', 'spec',
]);

const IGNORE_FILE_RE = /(_test\.(dart|php)|\.test\.(js|ts)|\.spec\.(js|ts)|mock_|fake_)/i;

const FLUTTER_RE = [
  /http\.(get|post|put|delete|patch)\(/i,
  /Dio\(\)/i,
  /\.get\s*\(|\.post\s*\(/,
  /onPressed|onTap|onLongPress|GestureDetector/,
  /TextEditingController|TextFormField|validator:/,
  /Navigator\.(push|pop|pushNamed)|GoRouter|context\.go\(/,
  /async\s|await\s|Future<|\.catchError\(/,
  /setState\s*\(|BlocProvider|ChangeNotifier|GetxController/,
];

const PHP_RE = [
  /public\s+function\s+\w+/,
  /\$this->input->(post|get)\b/,
  /\$_POST|\$_GET|\$_REQUEST/,
  /\$this->db->(get|insert|update|delete|where|query)\b/,
  /form_validation|set_rules/i,
  /echo\s+json_encode|json_encode\s*\(/,
  /\$this->session->/,
];

const NODE_RE = [
  /app\.(get|post|put|delete|patch|use)\s*\(/,
  /router\.(get|post|put|delete)\s*\(/,
  /req\.(body|params|query|headers)/,
  /res\.(json|send|status)\s*\(/,
  /try\s*\{|catch\s*\(/,
  /await\s|async\s/,
  /mongoose\.|\.findOne\(|\.find\(|\.create\(/i,
];

// ── Logo SVG ─────────────────────────────────────────────────────────────────

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none">
  <defs>
    <linearGradient id="lgShield" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7c3aed"/>
      <stop offset="100%" stop-color="#3b82f6"/>
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="1.5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <path d="M24 3 L42 10 L42 26 C42 35 34 42 24 46 C14 42 6 35 6 26 L6 10 Z"
        fill="url(#lgShield)" filter="url(#glow)"/>
  <text x="24" y="29" text-anchor="middle" font-family="'Segoe UI',sans-serif"
        font-size="14" font-weight="800" fill="white" letter-spacing="0.5">QA</text>
  <circle cx="36" cy="12" r="3" fill="#34d399" opacity="0.9"/>
</svg>`;

// ── Secure key helpers ────────────────────────────────────────────────────────

async function getApiKey(context) {
  return (await context.secrets.get('qaAgent.geminiKey')) || '';
}

async function promptForKey(context) {
  const key = await vscode.window.showInputBox({
    title: 'QA Super Agent — Gemini API Key',
    prompt: 'Paste your FREE Google Gemini API key. It is stored securely on your machine only.',
    placeHolder: 'AIzaSy...',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => v && v.trim().length > 10 ? null : 'Key looks too short',
  });
  if (!key) return null;
  await context.secrets.store('qaAgent.geminiKey', key.trim());
  vscode.window.showInformationMessage('QA Super Agent: API key saved securely ✅');
  return key.trim();
}

// ── Sidebar WebviewView Provider ──────────────────────────────────────────────

class QASidebarProvider {
  constructor(context) {
    this._context = context;
  }

  resolveWebviewView(webviewView) {
    webviewView.webview.options = { enableScripts: true, retainContextWhenHidden: true };
    webviewView.webview.html = sidebarHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'generate':
          vscode.commands.executeCommand('qa.generateTestCases');
          break;
        case 'setKey':
          vscode.commands.executeCommand('qa.changeApiKey');
          break;
        case 'getKey':
          vscode.env.openExternal(vscode.Uri.parse('https://aistudio.google.com/apikey'));
          break;
        case 'tutorial':
          vscode.commands.executeCommand('qa.showTutorial');
          break;
        case 'savedResults':
          vscode.commands.executeCommand('qa.viewSavedResults');
          break;
      }
    }, undefined, this._context.subscriptions);
  }
}

// ── Extension activate ────────────────────────────────────────────────────────

function activate(context) {
  const generateCmd = vscode.commands.registerCommand('qa.generateTestCases', async () => {
    const config = vscode.workspace.getConfiguration('qaAgent');
    const serverUrl = config.get('serverUrl', 'http://localhost:8000');

    let apiKey = await getApiKey(context);
    if (!apiKey) {
      apiKey = await promptForKey(context);
      if (!apiKey) return;
    }

    const panel = createWebviewPanel(context);
    panel.webview.html = loadingHtml();

    try {
      const { featureDesc, frontendCode, backendCode } = await collectInput();

      if (!featureDesc && !frontendCode && !backendCode) {
        panel.webview.html = errorHtml('No input found. Open a Flutter/PHP/Node project or select code.');
        return;
      }

      const result = await callAPI(serverUrl, {
        api_key: apiKey,
        model: config.get('model', 'gemini-2.0-flash'),
        feature_description: featureDesc,
        frontend_code: frontendCode,
        backend_code: backendCode,
      });

      const record = localStorage.saveResult(context, result);
      panel.webview.html = resultsHtml(result, record.id);

      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.command === 'export') {
          const rec = localStorage.loadResult(context, msg.id);
          if (rec) await dataSharing.exportResult(rec);
        } else if (msg.command === 'openSaved') {
          vscode.commands.executeCommand('qa.viewSavedResults');
        }
      }, undefined, context.subscriptions);
    } catch (err) {
      panel.webview.html = errorHtml(err.message || String(err));
    }
  });

  const tutorialCmd = vscode.commands.registerCommand('qa.showTutorial', () => {
    showTutorialPanel(context);
  });

  const settingsCmd = vscode.commands.registerCommand('qa.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', 'qaAgent');
  });

  const changeKeyCmd = vscode.commands.registerCommand('qa.changeApiKey', async () => {
    await promptForKey(context);
  });

  const clearKeyCmd = vscode.commands.registerCommand('qa.clearApiKey', async () => {
    await context.secrets.delete('qaAgent.geminiKey');
    vscode.window.showInformationMessage('QA Super Agent: API key cleared.');
  });

  const savedResultsCmd = vscode.commands.registerCommand('qa.viewSavedResults', () => {
    const panel = vscode.window.createWebviewPanel(
      'qaSavedResults', 'QA Super Agent — Saved Results',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const records = localStorage.listResults(context);
    panel.webview.html = savedResultsHtml(records);

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'load') {
        const rec = localStorage.loadResult(context, msg.id);
        if (!rec) { vscode.window.showErrorMessage('QA Super Agent: Result not found.'); return; }
        const p = createWebviewPanel(context);
        p.webview.html = resultsHtml(rec.result, rec.id);
        p.webview.onDidReceiveMessage(async (m) => {
          if (m.command === 'export') {
            const r = localStorage.loadResult(context, m.id);
            if (r) await dataSharing.exportResult(r);
          }
        }, undefined, context.subscriptions);
      } else if (msg.command === 'delete') {
        localStorage.deleteResult(context, msg.id);
        panel.webview.html = savedResultsHtml(localStorage.listResults(context));
        vscode.window.showInformationMessage('QA Super Agent: Result deleted.');
      } else if (msg.command === 'export') {
        const rec = localStorage.loadResult(context, msg.id);
        if (rec) await dataSharing.exportResult(rec);
      } else if (msg.command === 'import') {
        const imported = await dataSharing.importResult();
        if (!imported) return;
        localStorage.saveResult(context, imported.result, imported.label);
        vscode.window.showInformationMessage(`QA Super Agent: Imported "${imported.label}".`);
        panel.webview.html = savedResultsHtml(localStorage.listResults(context));
      }
    }, undefined, context.subscriptions);
  });

  const exportCmd = vscode.commands.registerCommand('qa.exportResult', async () => {
    const records = localStorage.listResults(context);
    if (records.length === 0) {
      vscode.window.showInformationMessage('QA Super Agent: No saved results to export.');
      return;
    }
    const items = records.map(r => ({ label: r.label, description: new Date(r.savedAt).toLocaleString(), id: r.id }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Export QA Result', placeHolder: 'Select a result to export' });
    if (!picked) return;
    const rec = localStorage.loadResult(context, picked.id);
    if (rec) await dataSharing.exportResult(rec);
  });

  const importCmd = vscode.commands.registerCommand('qa.importResult', async () => {
    const imported = await dataSharing.importResult();
    if (!imported) return;
    localStorage.saveResult(context, imported.result, imported.label);
    vscode.window.showInformationMessage(`QA Super Agent: Imported "${imported.label}" successfully.`);
  });

  const sidebarProvider = vscode.window.registerWebviewViewProvider(
    'qaAgent.sidebarView',
    new QASidebarProvider(context)
  );

  context.subscriptions.push(
    generateCmd, tutorialCmd, settingsCmd, changeKeyCmd, clearKeyCmd,
    savedResultsCmd, exportCmd, importCmd, sidebarProvider
  );
}

function deactivate() {}

// ── Tutorial panel ────────────────────────────────────────────────────────────

function showTutorialPanel(context) {
  const panel = vscode.window.createWebviewPanel(
    'qaTutorial', 'QA Super Agent — Tutorial',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.webview.html = tutorialHtml();
}

// ── Input collection ─────────────────────────────────────────────────────────

async function collectInput() {
  const editor = vscode.window.activeTextEditor;
  let featureDesc = '';
  let frontendCode = '';
  let backendCode = '';

  if (editor && !editor.selection.isEmpty) {
    const selected = editor.document.getText(editor.selection);
    const lang = editor.document.languageId;

    if (lang === 'dart') frontendCode = selected;
    else if (lang === 'php') backendCode = selected;
    else if (['javascript', 'typescript'].includes(lang)) backendCode = selected;
    else featureDesc = selected;

    return { featureDesc, frontendCode, backendCode };
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return { featureDesc, frontendCode, backendCode };
  }

  const root = folders[0].uri.fsPath;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'QA Agent: Scanning project...', cancellable: false },
    async () => {
      const { fe, be } = scanDirectory(root);
      frontendCode = fe.slice(0, 40000);
      backendCode  = be.slice(0, 40000);
    }
  );

  return { featureDesc, frontendCode, backendCode };
}

// ── Directory scanner ─────────────────────────────────────────────────────────

function scanDirectory(root) {
  const feChunks = [];
  const beChunks = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }

      const fname = entry.name;
      const ext = path.extname(fname).toLowerCase();
      if (!fname || IGNORE_FILE_RE.test(fname)) continue;

      const fpath = path.join(dir, fname);
      let stat;
      try { stat = fs.statSync(fpath); } catch { continue; }
      if (stat.size > 120000 || stat.size === 0) continue;

      let content;
      try { content = fs.readFileSync(fpath, 'utf8'); } catch { continue; }

      const rel = path.relative(root, fpath);
      let extracted = '';

      if (ext === '.dart') extracted = extractLines(content, FLUTTER_RE, rel);
      else if (ext === '.php') extracted = extractLines(content, PHP_RE, rel);
      else if (['.js', '.ts'].includes(ext)) extracted = extractLines(content, NODE_RE, rel);

      if (!extracted) continue;

      const block = `### ${rel}\n${extracted.slice(0, 4000)}`;
      if (ext === '.dart') feChunks.push(block);
      else beChunks.push(block);
    }
  }

  walk(root);
  return { fe: feChunks.join('\n\n'), be: beChunks.join('\n\n') };
}

function extractLines(content, patterns, _rel) {
  const lines = content.split('\n');
  const matched = new Set();

  for (const re of patterns) {
    lines.forEach((line, i) => {
      if (re.test(line)) {
        for (let j = Math.max(0, i - 2); j < Math.min(lines.length, i + 6); j++) {
          matched.add(j);
        }
      }
    });
  }

  if (matched.size === 0) return '';

  const sorted = [...matched].sort((a, b) => a - b);
  const result = [];
  let prev = -2;
  for (const idx of sorted) {
    if (idx - prev > 1 && result.length) result.push('  // ...');
    result.push(lines[idx]);
    prev = idx;
  }
  return result.join('\n');
}

// ── API call ──────────────────────────────────────────────────────────────────

function callAPI(serverUrl, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL('/qa-super-agent', serverUrl);
    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) reject(new Error(parsed.detail || `API error ${res.statusCode}`));
            else resolve(parsed);
          } catch {
            reject(new Error('Server returned invalid JSON. Is the QA backend running?'));
          }
        });
      }
    );

    req.on('error', (e) => {
      reject(new Error(
        e.code === 'ECONNREFUSED'
          ? `Cannot connect to QA backend at ${serverUrl}. Run: python api.py`
          : e.message
      ));
    });

    req.setTimeout(90000, () => { req.destroy(); reject(new Error('Request timed out (90s).')); });
    req.write(body);
    req.end();
  });
}

// ── Webview panel ─────────────────────────────────────────────────────────────

function createWebviewPanel(context) {
  return vscode.window.createWebviewPanel(
    'qaAgent', 'QA Super Agent',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
}

// ── Shared dark-theme base styles ─────────────────────────────────────────────

const BASE_STYLE = `
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  @keyframes fadeIn   { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:none; } }
  @keyframes fadeInFast { from { opacity:0; } to { opacity:1; } }
  @keyframes pulse    { 0%,100% { opacity:1; } 50% { opacity:.5; } }
  @keyframes spin     { to { transform:rotate(360deg); } }
  @keyframes shimmer  { 0% { background-position:-200% 0; } 100% { background-position:200% 0; } }
  @keyframes slideDown{ from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:none; } }
  @keyframes scaleIn  { from { opacity:0; transform:scale(.92); } to { opacity:1; transform:scale(1); } }

  *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }

  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: 13px;
    background: #0d0d14;
    color: #e2e8f0;
    padding: 0;
    line-height: 1.6;
  }

  /* ── Header ── */
  .header {
    background: linear-gradient(135deg, #0f0c29 0%, #1a0733 50%, #0f2460 100%);
    border-bottom: 1px solid rgba(124,58,237,.35);
    padding: 22px 24px 18px;
    display: flex;
    align-items: center;
    gap: 16px;
    position: relative;
    overflow: hidden;
    animation: fadeInFast .5s ease both;
  }
  .header::before {
    content:'';
    position:absolute; inset:0;
    background: radial-gradient(ellipse at 20% 50%, rgba(124,58,237,.18) 0%, transparent 65%),
                radial-gradient(ellipse at 80% 50%, rgba(59,130,246,.14) 0%, transparent 65%);
    pointer-events:none;
  }
  .header-logo { flex-shrink:0; filter:drop-shadow(0 0 10px rgba(124,58,237,.7)); }
  .header-text h1 { font-size:18px; font-weight:800; color:#fff;
                    text-shadow:0 0 20px rgba(124,58,237,.6); letter-spacing:.02em; }
  .header-text p  { font-size:11px; color:rgba(255,255,255,.65); margin-top:3px; }

  /* ── Content ── */
  .content { padding: 20px 24px; }

  /* ── Metric cards ── */
  .metrics { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:22px; }
  .metric {
    background: linear-gradient(145deg, #161625, #1e1e30);
    border: 1px solid rgba(124,58,237,.25);
    border-radius:10px; padding:14px; text-align:center;
    animation: scaleIn .4s ease both;
    transition: transform .15s, box-shadow .15s;
  }
  .metric:hover { transform:translateY(-2px); box-shadow:0 6px 20px rgba(124,58,237,.2); }
  .metric-num { font-size:26px; font-weight:800; color:#60a5fa; }
  .metric-lbl { font-size:10px; color:#94a3b8; margin-top:2px; text-transform:uppercase; letter-spacing:.06em; }

  /* ── Sections ── */
  .section {
    margin-bottom:14px;
    border: 1px solid rgba(255,255,255,.08);
    border-radius:10px; overflow:hidden;
    animation: slideDown .35s ease both;
    background: #12121e;
  }
  .section-header {
    display:flex; align-items:center; gap:8px;
    padding:11px 16px;
    background: linear-gradient(90deg, #1a1a2e, #141426);
    font-size:12px; font-weight:700; letter-spacing:.05em;
    cursor:pointer; user-select:none;
    transition: background .15s;
  }
  .section-header:hover { background: linear-gradient(90deg,#20203a,#1a1a30); }
  .section-header .icon { font-size:15px; }
  .section-header .chevron {
    margin-left:auto; color:#64748b; font-size:10px;
    transition:transform .25s;
  }
  .section-header.open .chevron { transform:rotate(180deg); }
  .section-header .count {
    margin-left:6px;
    background:rgba(124,58,237,.35); color:#c4b5fd;
    border-radius:10px; padding:1px 8px; font-size:10px;
  }
  .section-body { padding:14px 16px; display:none; }
  .section-body.open { display:block; animation:slideDown .2s ease both; }

  /* ── Summary ── */
  .summary-text { font-size:13px; line-height:1.75; color:#cbd5e1; }

  /* ── Test case cards ── */
  .tc-card {
    border:1px solid rgba(255,255,255,.08); border-radius:8px;
    padding:13px 15px; margin-bottom:10px;
    background: linear-gradient(145deg,#0f0f1d,#161626);
    transition: border-color .15s, box-shadow .15s;
    animation: fadeIn .3s ease both;
  }
  .tc-card:hover { border-color:rgba(96,165,250,.35); box-shadow:0 4px 16px rgba(96,165,250,.08); }
  .tc-header { display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap; }
  .tc-id { font-weight:700; font-size:12px; color:#60a5fa; }
  .tc-scenario { font-size:12px; font-weight:600; flex:1; }
  .badge { display:inline-block; padding:2px 9px; border-radius:4px;
           font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
  .badge-high   { background:rgba(239,68,68,.2);   color:#fca5a5; border:1px solid rgba(239,68,68,.3); }
  .badge-medium { background:rgba(245,158,11,.18); color:#fde68a; border:1px solid rgba(245,158,11,.3); }
  .badge-low    { background:rgba(52,211,153,.18); color:#86efac; border:1px solid rgba(52,211,153,.3); }
  .badge-type   { background:rgba(124,58,237,.2);  color:#c4b5fd; border:1px solid rgba(124,58,237,.3); }
  .tc-meta { font-size:11px; color:#64748b; margin-bottom:6px; }
  .tc-label { font-size:11px; font-weight:700; color:#94a3b8; margin-top:8px; margin-bottom:3px; }
  .steps { padding-left:18px; font-size:12px; }
  .steps li { margin-bottom:3px; }
  .expected {
    font-size:12px;
    background:rgba(96,165,250,.07);
    border-left:3px solid #60a5fa;
    padding:7px 11px; border-radius:0 6px 6px 0; margin-top:6px;
  }

  /* ── Failure cards ── */
  .failure-card {
    border-left:4px solid #f87171;
    background:rgba(239,68,68,.07);
    padding:11px 13px; border-radius:0 8px 8px 0; margin-bottom:9px;
  }
  .failure-title { font-weight:700; font-size:12px; color:#f87171; margin-bottom:5px; }
  .failure-row   { font-size:11px; margin-bottom:2px; }
  .failure-row span { font-weight:600; color:#94a3b8; }

  /* ── Code issues ── */
  .issue-item { font-size:12px; padding:5px 0; border-bottom:1px solid rgba(255,255,255,.05); }
  .issue-item:last-child { border-bottom:none; }
  .issue-fe { border-left:3px solid #60a5fa; padding-left:9px; }
  .issue-be { border-left:3px solid #34d399; padding-left:9px; }

  /* ── Scenarios ── */
  .scenario-item { font-size:12px; padding:4px 0 4px 14px; position:relative; }
  .scenario-item::before { content:"›"; position:absolute; left:0; color:#7c3aed; font-weight:700; }

  /* ── Coverage grid ── */
  .coverage-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
  .cov-item {
    display:flex; align-items:center; gap:8px; font-size:12px;
    padding:7px 11px; border-radius:7px;
    background: rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.06);
  }
  .cov-ok { color:#34d399; font-size:16px; }
  .cov-no { color:#f87171; font-size:16px; }

  /* ── Filter bar ── */
  .filter-bar { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px; }
  .filter-btn {
    padding:3px 11px; border-radius:5px;
    border:1px solid rgba(255,255,255,.12);
    background:transparent; color:#94a3b8; font-size:11px;
    cursor:pointer; transition:all .15s;
  }
  .filter-btn:hover { border-color:#7c3aed; color:#c4b5fd; }
  .filter-btn.active { background:#7c3aed; border-color:#7c3aed; color:#fff; }

  .empty { font-size:12px; color:#64748b; font-style:italic; }
</style>`;

// ── Sidebar HTML ──────────────────────────────────────────────────────────────

function sidebarHtml() {
  return `<!DOCTYPE html><html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
        font-size: 13px;
        background: #0d0d14;
        color: #e2e8f0;
        padding: 0;
        line-height: 1.5;
      }

      .sidebar-header {
        background: linear-gradient(135deg, #0f0c29 0%, #1a0733 50%, #0f2460 100%);
        border-bottom: 1px solid rgba(124,58,237,.35);
        padding: 16px 14px 14px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .sidebar-header svg { flex-shrink: 0; filter: drop-shadow(0 0 8px rgba(124,58,237,.7)); }
      .sidebar-header h1 { font-size: 13px; font-weight: 800; color: #fff; letter-spacing: .02em; }
      .sidebar-header p  { font-size: 10px; color: rgba(255,255,255,.55); margin-top: 2px; }

      .section-label {
        font-size: 10px; font-weight: 700; letter-spacing: .08em;
        text-transform: uppercase; color: #64748b;
        padding: 14px 14px 6px;
      }

      .btn {
        display: flex; align-items: center; gap: 10px;
        width: calc(100% - 28px); margin: 0 14px 8px;
        padding: 9px 13px; border-radius: 8px;
        border: none; cursor: pointer;
        font-size: 12px; font-weight: 600;
        transition: all .15s; text-align: left;
      }
      .btn-primary {
        background: linear-gradient(135deg, #7c3aed, #3b82f6);
        color: #fff;
        box-shadow: 0 3px 12px rgba(124,58,237,.3);
      }
      .btn-primary:hover { opacity: .88; transform: translateY(-1px); }

      .btn-secondary {
        background: rgba(255,255,255,.06);
        color: #94a3b8;
        border: 1px solid rgba(255,255,255,.09);
      }
      .btn-secondary:hover { background: rgba(255,255,255,.11); color: #e2e8f0; }

      .btn-gemini {
        background: rgba(52,211,153,.1);
        color: #34d399;
        border: 1px solid rgba(52,211,153,.25);
      }
      .btn-gemini:hover { background: rgba(52,211,153,.2); }

      .btn-icon { font-size: 15px; flex-shrink: 0; }

      .divider {
        height: 1px;
        background: rgba(255,255,255,.06);
        margin: 6px 14px 10px;
      }

      .key-box {
        margin: 0 14px 14px;
        padding: 11px 13px;
        border-radius: 8px;
        background: rgba(124,58,237,.08);
        border: 1px solid rgba(124,58,237,.2);
        font-size: 11px;
        color: #c4b5fd;
        line-height: 1.6;
      }
      .key-box strong { color: #e2e8f0; }
      .key-box .arrow { color: #7c3aed; font-weight: 700; }
    </style>
  </head>
  <body>

    <div class="sidebar-header">
      ${LOGO_SVG}
      <div>
        <h1>QA Super Agent</h1>
        <p>AI-powered QA for Flutter · PHP · Node</p>
      </div>
    </div>

    <div class="section-label">Actions</div>

    <button class="btn btn-primary" onclick="send('generate')">
      <span class="btn-icon">⚡</span>
      <span>Generate Test Cases</span>
    </button>

    <div class="section-label">Gemini API Key</div>

    <div class="key-box">
      <strong>Need a free key?</strong><br>
      Click below to open Google AI Studio — sign in and hit <span class="arrow">Create API key</span>.
      It's free, no billing required.
    </div>

    <button class="btn btn-gemini" onclick="send('getKey')">
      <span class="btn-icon">🔑</span>
      <span>Get Free Gemini API Key ↗</span>
    </button>

    <button class="btn btn-secondary" onclick="send('setKey')">
      <span class="btn-icon">✏️</span>
      <span>Set / Change API Key</span>
    </button>

    <div class="divider"></div>

    <div class="section-label">More</div>

    <button class="btn btn-secondary" onclick="send('savedResults')">
      <span class="btn-icon">📂</span>
      <span>View Saved Results</span>
    </button>

    <button class="btn btn-secondary" onclick="send('tutorial')">
      <span class="btn-icon">📖</span>
      <span>Show Tutorial</span>
    </button>

    <script>
      const vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;
      function send(command) {
        if (vscodeApi) vscodeApi.postMessage({ command });
      }
    </script>
  </body>
  </html>`;
}

// ── Loading HTML ──────────────────────────────────────────────────────────────

function loadingHtml() {
  return `<!DOCTYPE html><html><head>${BASE_STYLE}
  <style>
    @keyframes orbit {
      from { transform:rotate(0deg) translateX(28px) rotate(0deg); }
      to   { transform:rotate(360deg) translateX(28px) rotate(-360deg); }
    }
    .loader { display:flex; flex-direction:column; align-items:center; justify-content:center;
              height:65vh; gap:18px; }
    .spinner-wrap { position:relative; width:64px; height:64px; }
    .ring {
      position:absolute; inset:0; border-radius:50%;
      border:2px solid transparent;
      border-top-color:#7c3aed;
      animation:spin .9s linear infinite;
    }
    .ring-2 {
      inset:8px;
      border-top-color:#3b82f6;
      animation:spin 1.4s linear infinite reverse;
    }
    .orbit-dot {
      position:absolute; width:8px; height:8px; border-radius:50%;
      background:#34d399; top:50%; left:50%;
      margin:-4px 0 0 -4px;
      animation:orbit 2s linear infinite;
    }
    .load-title { font-size:15px; font-weight:700; color:#e2e8f0; }
    .load-sub {
      font-size:11px; color:#64748b;
      background: linear-gradient(90deg,#64748b,#c4b5fd,#60a5fa,#64748b);
      background-size:200%;
      -webkit-background-clip:text; -webkit-text-fill-color:transparent;
      animation:shimmer 2.5s linear infinite;
    }
  </style>
  </head><body>
  <div class="header">
    <div class="header-logo">${LOGO_SVG}</div>
    <div class="header-text">
      <h1>QA Super Agent</h1>
      <p>AI-powered test case generation</p>
    </div>
  </div>
  <div class="loader">
    <div class="spinner-wrap">
      <div class="ring"></div>
      <div class="ring ring-2"></div>
      <div class="orbit-dot"></div>
    </div>
    <div class="load-title">Generating QA Analysis…</div>
    <div class="load-sub">Scanning code &nbsp;·&nbsp; Calling AI &nbsp;·&nbsp; Building test cases</div>
  </div>
  </body></html>`;
}

// ── Error HTML ────────────────────────────────────────────────────────────────

function errorHtml(msg) {
  return `<!DOCTYPE html><html><head>${BASE_STYLE}</head><body>
  <div class="header">
    <div class="header-logo">${LOGO_SVG}</div>
    <div class="header-text"><h1>QA Super Agent</h1><p>AI-powered test case generation</p></div>
  </div>
  <div class="content">
    <div class="section" style="border-color:rgba(239,68,68,.3);">
      <div class="section-header open" style="background:rgba(239,68,68,.12); color:#f87171;">
        <span class="icon">❌</span> Error
        <span class="chevron">▼</span>
      </div>
      <div class="section-body open" style="color:#f87171; font-size:13px;">
        <b>${esc(msg)}</b><br><br>
        <b style="color:#94a3b8;">Checklist:</b>
        <ul style="margin-top:8px; padding-left:18px; font-size:12px; line-height:2.1; color:#cbd5e1;">
          <li>Is the QA backend running? → <code style="color:#60a5fa;">python api.py</code></li>
          <li>Is the Gemini API key set? → Run <em>QA: Set / Change Gemini API Key</em></li>
          <li>Server URL correct? Default: <code style="color:#60a5fa;">http://localhost:8000</code></li>
        </ul>
      </div>
    </div>
  </div>
  </body></html>`;
}

// ── Results HTML ──────────────────────────────────────────────────────────────

function resultsHtml(data, recordId) {
  const tcs      = data.test_cases || [];
  const scenarios = data.test_scenarios || [];
  const failures  = data.predicted_failures || [];
  const codeIssues = data.code_issues || {};
  const coverage   = data.coverage_report || {};

  const high   = tcs.filter(t => t.priority === 'High').length;
  const medium = tcs.filter(t => t.priority === 'Medium').length;
  const low    = tcs.filter(t => t.priority === 'Low').length;

  const metricsHtml = `
    <div class="metrics">
      <div class="metric" style="animation-delay:.05s">
        <div class="metric-num">${tcs.length}</div><div class="metric-lbl">Total Cases</div>
      </div>
      <div class="metric" style="animation-delay:.10s">
        <div class="metric-num" style="color:#f87171">${high}</div><div class="metric-lbl">High Priority</div>
      </div>
      <div class="metric" style="animation-delay:.15s">
        <div class="metric-num" style="color:#fde68a">${medium}</div><div class="metric-lbl">Medium Priority</div>
      </div>
      <div class="metric" style="animation-delay:.20s">
        <div class="metric-num" style="color:#86efac">${low}</div><div class="metric-lbl">Low Priority</div>
      </div>
    </div>`;

  const summaryHtml = data.summary ? collapsibleSection(
    '📝', 'Summary', '', `<div class="summary-text">${esc(data.summary)}</div>`, true, '.05s'
  ) : '';

  const scenariosHtml = scenarios.length ? collapsibleSection(
    '🎯', 'Test Scenarios', scenarios.length,
    scenarios.map(s => `<div class="scenario-item">${esc(s)}</div>`).join(''),
    true, '.10s'
  ) : '';

  const tcCards = tcs.map(tc => {
    const pClass = (tc.priority || 'medium').toLowerCase();
    const steps = (tc.steps || []).map(s => `<li>${esc(s)}</li>`).join('');
    return `<div class="tc-card" data-type="${esc(tc.type)}" data-priority="${esc(tc.priority)}">
      <div class="tc-header">
        <span class="tc-id">${esc(tc.id)}</span>
        <span class="tc-scenario">${esc(tc.scenario)}</span>
        <span class="badge badge-${pClass}">${esc(tc.priority)}</span>
        <span class="badge badge-type">${esc(tc.type)}</span>
      </div>
      <div class="tc-meta">Severity: ${esc(tc.severity)} · Preconditions: ${esc(tc.preconditions)}</div>
      <div class="tc-label">Steps</div>
      <ol class="steps">${steps}</ol>
      <div class="tc-label">Expected Result</div>
      <div class="expected">${esc(tc.expected_result)}</div>
    </div>`;
  }).join('');

  const allTypes = [...new Set(tcs.map(t => t.type).filter(Boolean))].sort();
  const filterBar = allTypes.length ? `
    <div class="filter-bar" id="filterBar">
      <button class="filter-btn active" data-filter="all">All</button>
      ${allTypes.map(t => `<button class="filter-btn" data-filter="${esc(t)}">${esc(t)}</button>`).join('')}
    </div>` : '';

  const tcSection = collapsibleSection(
    '🧾', 'Test Cases', tcs.length,
    filterBar + `<div id="tcList">${tcCards || '<div class="empty">No test cases returned.</div>'}</div>`,
    true, '.15s'
  );

  const failureCards = failures.map((f, i) => `
    <div class="failure-card">
      <div class="failure-title">${i + 1}. ${esc(f.issue)}</div>
      <div class="failure-row"><span>Root Cause:</span> ${esc(f.root_cause)}</div>
      <div class="failure-row"><span>Trigger:</span> ${esc(f.trigger_condition)}</div>
      <div class="failure-row"><span>Impact:</span> ${esc(f.impact)}</div>
    </div>`).join('');

  const failuresSection = collapsibleSection(
    '🚨', 'Predicted Failures', failures.length,
    failureCards || '<div class="empty">No failures predicted.</div>',
    failures.length > 0, '.20s'
  );

  const feIssues = (codeIssues.frontend || []).map(i =>
    `<div class="issue-item issue-fe">FE: ${esc(i)}</div>`).join('');
  const beIssues = (codeIssues.backend || []).map(i =>
    `<div class="issue-item issue-be">BE: ${esc(i)}</div>`).join('');
  const issuesSection = collapsibleSection(
    '🧩', 'Code Issues',
    (codeIssues.frontend || []).length + (codeIssues.backend || []).length,
    feIssues + beIssues || '<div class="empty">No code issues found.</div>',
    false, '.25s'
  );

  const covMap = { functional:'Functional', negative:'Negative', edge:'Edge Cases', ui:'UI Validation', api:'API' };
  const covItems = Object.entries(covMap).map(([k, label]) => {
    const ok = coverage[k] ?? coverage['positive'] ?? false;
    return `<div class="cov-item"><span class="${ok ? 'cov-ok' : 'cov-no'}">${ok ? '✅' : '❌'}</span>${label}</div>`;
  }).join('');
  const covSection = collapsibleSection('✅', 'Coverage Report', '',
    `<div class="coverage-grid">${covItems}</div>`, false, '.30s');

  const actionBar = recordId ? `
  <div class="action-bar">
    <span class="action-saved-badge">💾 Auto-saved locally</span>
    <button class="action-btn" onclick="doExport()">⬆ Export&hellip;</button>
    <button class="action-btn action-btn-secondary" onclick="openSaved()">📂 View Saved Results</button>
  </div>` : '';

  return `<!DOCTYPE html><html><head>${BASE_STYLE}
  <style>
    .action-bar {
      display:flex; align-items:center; gap:10px; flex-wrap:wrap;
      padding:10px 24px; background:rgba(52,211,153,.06);
      border-bottom:1px solid rgba(52,211,153,.18);
      animation:fadeInFast .4s ease both;
    }
    .action-saved-badge { font-size:11px; color:#34d399; flex:1; }
    .action-btn {
      padding:5px 14px; border-radius:7px; font-size:12px; font-weight:600;
      cursor:pointer; border:none; transition:all .15s;
      background:linear-gradient(135deg,#7c3aed,#3b82f6); color:#fff;
    }
    .action-btn:hover { opacity:.85; transform:translateY(-1px); }
    .action-btn-secondary {
      background:rgba(255,255,255,.07); color:#94a3b8;
      border:1px solid rgba(255,255,255,.1);
    }
    .action-btn-secondary:hover { background:rgba(255,255,255,.12); color:#e2e8f0; transform:none; opacity:1; }
  </style>
  </head><body>
  <div class="header">
    <div class="header-logo">${LOGO_SVG}</div>
    <div class="header-text">
      <h1>QA Super Agent</h1>
      <p>Analysis complete &nbsp;·&nbsp; ${tcs.length} test cases generated</p>
    </div>
  </div>
  ${actionBar}
  <div class="content">
    ${metricsHtml}
    ${summaryHtml}
    ${scenariosHtml}
    ${tcSection}
    ${failuresSection}
    ${issuesSection}
    ${covSection}
  </div>
  <script>
    const vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;

    function doExport() {
      if (vscodeApi) vscodeApi.postMessage({ command: 'export', id: '${recordId || ''}' });
    }
    function openSaved() {
      if (vscodeApi) vscodeApi.postMessage({ command: 'openSaved' });
    }

    document.querySelectorAll('.section-header').forEach(h => {
      h.addEventListener('click', () => {
        const body = h.nextElementSibling;
        body.classList.toggle('open');
        h.classList.toggle('open');
      });
    });

    const filterBar = document.getElementById('filterBar');
    if (filterBar) {
      filterBar.addEventListener('click', e => {
        const btn = e.target.closest('.filter-btn');
        if (!btn) return;
        filterBar.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const filter = btn.dataset.filter;
        document.querySelectorAll('.tc-card').forEach(card => {
          card.style.display = (filter === 'all' || card.dataset.type === filter) ? '' : 'none';
        });
      });
    }
  </script>
  </body></html>`;
}

// ── Tutorial HTML ─────────────────────────────────────────────────────────────

function tutorialHtml() {
  const steps = [
    {
      icon: '🛡️',
      title: 'Welcome to QA Super Agent',
      body: `
        <p>QA Super Agent is your AI-powered quality assurance companion inside VS Code.</p>
        <p style="margin-top:14px">It uses <b>Google Gemini</b> to automatically:</p>
        <ul class="tut-list">
          <li>Generate structured test cases from your code</li>
          <li>Predict real-world failures before they reach production</li>
          <li>Detect code issues in Flutter, PHP, and Node.js</li>
          <li>Produce a coverage report for each analysis</li>
        </ul>
        <p style="margin-top:14px; color:#94a3b8; font-size:11px;">Everything runs locally — your code never leaves your machine.</p>`,
    },
    {
      icon: '🔑',
      title: 'Step 1 — Get a Free Gemini API Key',
      body: `
        <p>QA Super Agent is powered by <b>Google Gemini</b> (free tier). No billing required.</p>
        <ol class="tut-list tut-ol">
          <li>Visit <a href="https://aistudio.google.com/apikey" class="link">aistudio.google.com/apikey</a></li>
          <li>Sign in with your Google account</li>
          <li>Click <b>"Create API key"</b></li>
          <li>Copy the key (starts with <code>AIzaSy…</code>)</li>
        </ol>
        <div class="tip-box">
          <span class="tip-icon">💡</span>
          Your key is stored in VS Code's encrypted secret store — never in plain text or shared settings.
        </div>`,
    },
    {
      icon: '⚙️',
      title: 'Step 2 — Start the Backend',
      body: `
        <p>The extension communicates with a lightweight local Python backend.</p>
        <p style="margin-top:12px">Open a terminal in your <code>qa_agent</code> folder and run:</p>
        <div class="code-block"><pre>pip install -r requirements.txt
uvicorn api:app --reload --port 8000</pre></div>
        <p style="margin-top:12px">The backend listens on <code>http://localhost:8000</code> by default.</p>
        <div class="tip-box">
          <span class="tip-icon">💡</span>
          You can change the server URL in VS Code Settings → <em>QA Super Agent</em> → <em>Server URL</em>.
        </div>`,
    },
    {
      icon: '▶️',
      title: 'Step 3 — Run Your First Analysis',
      body: `
        <p>Once the backend is running, trigger an analysis in any of these ways:</p>
        <div class="method-list">
          <div class="method-item">
            <div class="method-key">⌘ Shift Q</div>
            <div class="method-desc">Keyboard shortcut (Mac) &nbsp;/&nbsp; Ctrl+Shift+Q (Win/Linux)</div>
          </div>
          <div class="method-item">
            <div class="method-key">⌘ P</div>
            <div class="method-desc">Command Palette → <em>QA: Generate Test Cases &amp; Failure Analysis</em></div>
          </div>
          <div class="method-item">
            <div class="method-key">Right-click</div>
            <div class="method-desc">Select code → Right-click → <em>QA: Generate Test Cases</em></div>
          </div>
        </div>
        <div class="tip-box">
          <span class="tip-icon">💡</span>
          Select a specific code block to analyse just that snippet, or leave nothing selected to scan the whole project.
        </div>`,
    },
    {
      icon: '📊',
      title: 'Step 4 — Reading the Results',
      body: `
        <p>A side panel opens with your full QA report:</p>
        <div class="result-grid">
          <div class="result-item"><span class="result-icon">📝</span><b>Summary</b><br><small>High-level overview of what was analysed</small></div>
          <div class="result-item"><span class="result-icon">🎯</span><b>Test Scenarios</b><br><small>Key test areas identified by the AI</small></div>
          <div class="result-item"><span class="result-icon">🧾</span><b>Test Cases</b><br><small>Full cases with steps, priority, and expected results</small></div>
          <div class="result-item"><span class="result-icon">🚨</span><b>Predicted Failures</b><br><small>Likely bugs with root cause &amp; trigger conditions</small></div>
          <div class="result-item"><span class="result-icon">🧩</span><b>Code Issues</b><br><small>Frontend and backend code smells</small></div>
          <div class="result-item"><span class="result-icon">✅</span><b>Coverage Report</b><br><small>Functional / Negative / Edge / UI / API coverage</small></div>
        </div>`,
    },
    {
      icon: '✨',
      title: "You're All Set!",
      body: `
        <p>QA Super Agent is ready to use. Here are a few pro tips:</p>
        <ul class="tut-list">
          <li>Use <b>type filters</b> in the Test Cases panel to focus on Functional, Negative, or Edge tests</li>
          <li>Click any section header to collapse / expand it</li>
          <li>Run <em>QA: Set / Change Gemini API Key</em> to update your key at any time</li>
          <li>Re-open this tutorial via <em>QA: Show Tutorial</em> from the Command Palette</li>
        </ul>
        <div class="tip-box" style="border-color:rgba(52,211,153,.3); background:rgba(52,211,153,.07);">
          <span class="tip-icon">🎉</span>
          Happy testing! Press <b>Ctrl+Shift+Q</b> to run your first analysis.
        </div>`,
    },
  ];

  const stepsJson = JSON.stringify(steps);

  return `<!DOCTYPE html><html><head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    @keyframes fadeIn  { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:none} }
    @keyframes fadeOut { from{opacity:1;transform:none} to{opacity:0;transform:translateY(-10px)} }
    @keyframes spin    { to{transform:rotate(360deg)} }
    @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:.4} }

    *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: 13px; background:#0d0d14; color:#e2e8f0;
      min-height:100vh; display:flex; flex-direction:column;
    }

    .tut-header {
      background: linear-gradient(135deg,#0f0c29,#1a0733,#0f2460);
      border-bottom:1px solid rgba(124,58,237,.35);
      padding:20px 24px; display:flex; align-items:center; gap:14px;
    }
    .tut-header-logo { filter:drop-shadow(0 0 10px rgba(124,58,237,.7)); }
    .tut-header-text h1 { font-size:17px; font-weight:800; color:#fff; }
    .tut-header-text p  { font-size:11px; color:rgba(255,255,255,.6); margin-top:2px; }

    .progress-bar {
      height:3px; background:rgba(255,255,255,.07);
    }
    .progress-fill {
      height:100%; background:linear-gradient(90deg,#7c3aed,#3b82f6);
      transition:width .4s ease;
    }

    .step-dots {
      display:flex; justify-content:center; gap:8px; padding:16px 0 0;
    }
    .step-dot {
      width:8px; height:8px; border-radius:50%;
      background:rgba(255,255,255,.15); transition:all .25s; cursor:pointer;
    }
    .step-dot.active { background:#7c3aed; transform:scale(1.3); }
    .step-dot.done   { background:rgba(124,58,237,.45); }

    .step-wrap {
      flex:1; padding:24px 28px 16px; max-width:680px; margin:0 auto; width:100%;
    }
    .step-panel { animation:fadeIn .3s ease both; }
    .step-panel.out { animation:fadeOut .2s ease both; }

    .step-icon { font-size:36px; margin-bottom:12px; display:block; }
    .step-title { font-size:18px; font-weight:800; color:#fff; margin-bottom:14px;
                  text-shadow:0 0 24px rgba(124,58,237,.4); }
    .step-body p { font-size:13px; line-height:1.75; color:#cbd5e1; }
    .step-body p + p { margin-top:8px; }

    .tut-list { padding-left:20px; margin-top:10px; }
    .tut-list li { font-size:13px; line-height:1.9; color:#cbd5e1; }
    .tut-ol  { counter-reset:item; list-style:none; padding-left:0; }
    .tut-ol li { counter-increment:item; padding-left:26px; position:relative; }
    .tut-ol li::before {
      content:counter(item); position:absolute; left:0;
      width:18px; height:18px; border-radius:50%; text-align:center; line-height:18px;
      background:#7c3aed; color:#fff; font-size:10px; font-weight:700; top:4px;
    }

    .code-block {
      background:#0a0a15; border:1px solid rgba(124,58,237,.25);
      border-radius:8px; padding:12px 14px; margin-top:10px;
    }
    .code-block pre { font-family:'Fira Code','Cascadia Code',monospace; font-size:12px;
                      color:#c4b5fd; line-height:1.7; }

    .tip-box {
      display:flex; gap:10px; align-items:flex-start;
      margin-top:14px; padding:11px 13px; border-radius:8px;
      background:rgba(124,58,237,.1); border:1px solid rgba(124,58,237,.25);
      font-size:12px; color:#c4b5fd; line-height:1.6;
    }
    .tip-icon { font-size:16px; flex-shrink:0; margin-top:1px; }

    .link { color:#60a5fa; text-decoration:none; }
    .link:hover { text-decoration:underline; }

    code { background:rgba(96,165,250,.12); color:#93c5fd;
           padding:1px 5px; border-radius:4px; font-size:11px; }

    .method-list { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
    .method-item { display:flex; align-items:center; gap:12px;
                   padding:9px 13px; border-radius:8px;
                   background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); }
    .method-key  { font-size:11px; font-weight:700; color:#c4b5fd;
                   background:rgba(124,58,237,.2); padding:2px 8px; border-radius:4px;
                   white-space:nowrap; }
    .method-desc { font-size:12px; color:#94a3b8; }

    .result-grid { display:grid; grid-template-columns:1fr 1fr; gap:9px; margin-top:14px; }
    .result-item {
      padding:10px 12px; border-radius:8px; font-size:12px; line-height:1.5;
      background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07);
    }
    .result-item small { color:#64748b; font-size:11px; }
    .result-icon { font-size:16px; display:block; margin-bottom:4px; }

    .nav-row {
      display:flex; justify-content:space-between; align-items:center;
      padding:16px 28px 20px; max-width:680px; margin:0 auto; width:100%;
    }
    .nav-btn {
      padding:8px 20px; border-radius:8px; font-size:13px; font-weight:600;
      cursor:pointer; border:none; transition:all .15s;
    }
    .nav-btn-prev {
      background:rgba(255,255,255,.07); color:#94a3b8; border:1px solid rgba(255,255,255,.1);
    }
    .nav-btn-prev:hover { background:rgba(255,255,255,.12); color:#e2e8f0; }
    .nav-btn-next {
      background:linear-gradient(135deg,#7c3aed,#3b82f6); color:#fff;
      box-shadow:0 4px 14px rgba(124,58,237,.35);
    }
    .nav-btn-next:hover { box-shadow:0 6px 20px rgba(124,58,237,.5); transform:translateY(-1px); }
    .nav-btn:disabled { opacity:.3; cursor:default; transform:none !important; box-shadow:none !important; }
    .step-counter { font-size:11px; color:#64748b; }
  </style>
  </head><body>

  <div class="tut-header">
    <div class="tut-header-logo">${LOGO_SVG}</div>
    <div class="tut-header-text">
      <h1>QA Super Agent</h1>
      <p>Interactive Tutorial</p>
    </div>
  </div>

  <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>

  <div class="step-dots" id="stepDots"></div>

  <div class="step-wrap">
    <div id="stepPanel"></div>
  </div>

  <div class="nav-row">
    <button class="nav-btn nav-btn-prev" id="btnPrev" onclick="nav(-1)">← Back</button>
    <span class="step-counter" id="stepCounter"></span>
    <button class="nav-btn nav-btn-next" id="btnNext" onclick="nav(1)">Next →</button>
  </div>

  <script>
    const steps = ${stepsJson};
    let cur = 0;

    const dotsEl    = document.getElementById('stepDots');
    const panelEl   = document.getElementById('stepPanel');
    const fillEl    = document.getElementById('progressFill');
    const prevBtn   = document.getElementById('btnPrev');
    const nextBtn   = document.getElementById('btnNext');
    const counterEl = document.getElementById('stepCounter');

    steps.forEach((_, i) => {
      const d = document.createElement('div');
      d.className = 'step-dot';
      d.onclick = () => goTo(i);
      dotsEl.appendChild(d);
    });

    function render(animate) {
      const s = steps[cur];
      if (animate) {
        panelEl.classList.add('out');
        setTimeout(() => {
          panelEl.classList.remove('out');
          panelEl.innerHTML = buildStep(s);
        }, 200);
      } else {
        panelEl.innerHTML = buildStep(s);
      }

      const pct = steps.length > 1 ? (cur / (steps.length - 1)) * 100 : 0;
      fillEl.style.width = pct + '%';

      document.querySelectorAll('.step-dot').forEach((d, i) => {
        d.className = 'step-dot' + (i === cur ? ' active' : i < cur ? ' done' : '');
      });

      prevBtn.disabled = cur === 0;
      nextBtn.textContent = cur === steps.length - 1 ? 'Close ✓' : 'Next →';
      counterEl.textContent = (cur + 1) + ' / ' + steps.length;
    }

    function buildStep(s) {
      return '<div class="step-panel">'
           + '<span class="step-icon">' + s.icon + '</span>'
           + '<div class="step-title">' + s.title + '</div>'
           + '<div class="step-body">' + s.body + '</div>'
           + '</div>';
    }

    function nav(dir) {
      const next = cur + dir;
      if (next < 0) return;
      if (next >= steps.length) { return; }
      goTo(next);
    }

    function goTo(idx) {
      cur = idx;
      render(true);
    }

    nextBtn.addEventListener('click', () => {
      if (cur === steps.length - 1) return;
      nav(1);
    });

    render(false);
  </script>
  </body></html>`;
}

// ── Saved Results HTML ────────────────────────────────────────────────────────

function savedResultsHtml(records) {
  const rows = records.length === 0
    ? `<div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">No saved results yet</div>
        <div class="empty-sub">Run <b>QA: Generate Test Cases</b> to create your first analysis.</div>
       </div>`
    : records.map(r => `
      <div class="result-row" data-id="${esc(r.id)}">
        <div class="result-row-info">
          <div class="result-row-label">${esc(r.label)}</div>
          <div class="result-row-date">${esc(new Date(r.savedAt).toLocaleString())}</div>
        </div>
        <div class="result-row-actions">
          <button class="row-btn row-btn-open"  onclick="doLoad('${esc(r.id)}')">Open</button>
          <button class="row-btn row-btn-export" onclick="doExport('${esc(r.id)}')">⬆ Export</button>
          <button class="row-btn row-btn-delete" onclick="doDelete('${esc(r.id)}')">✕</button>
        </div>
      </div>`).join('');

  return `<!DOCTYPE html><html><head>${BASE_STYLE}
  <style>
    .page-header { padding:18px 24px 14px; border-bottom:1px solid rgba(255,255,255,.07); }
    .page-header h2 { font-size:15px; font-weight:800; color:#fff; }
    .page-header p  { font-size:11px; color:#64748b; margin-top:3px; }

    .toolbar {
      display:flex; gap:8px; padding:12px 24px;
      border-bottom:1px solid rgba(255,255,255,.06);
    }
    .tb-btn {
      padding:5px 14px; border-radius:7px; font-size:12px; font-weight:600;
      cursor:pointer; border:none; transition:all .15s;
      background:linear-gradient(135deg,#7c3aed,#3b82f6); color:#fff;
    }
    .tb-btn:hover { opacity:.85; }
    .tb-btn-sec {
      background:rgba(255,255,255,.07); color:#94a3b8;
      border:1px solid rgba(255,255,255,.1);
    }
    .tb-btn-sec:hover { background:rgba(255,255,255,.12); color:#e2e8f0; opacity:1; }

    .results-list { padding:12px 24px; display:flex; flex-direction:column; gap:8px; }

    .result-row {
      display:flex; align-items:center; gap:12px;
      padding:11px 14px; border-radius:9px;
      background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07);
      animation:fadeIn .25s ease both; transition:border-color .15s;
    }
    .result-row:hover { border-color:rgba(124,58,237,.35); }
    .result-row-info { flex:1; min-width:0; }
    .result-row-label { font-size:13px; font-weight:600; color:#e2e8f0;
                        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .result-row-date  { font-size:11px; color:#64748b; margin-top:2px; }
    .result-row-actions { display:flex; gap:6px; flex-shrink:0; }

    .row-btn {
      padding:4px 11px; border-radius:6px; font-size:11px; font-weight:600;
      cursor:pointer; border:none; transition:all .12s;
    }
    .row-btn-open   { background:rgba(96,165,250,.2); color:#93c5fd; border:1px solid rgba(96,165,250,.3); }
    .row-btn-open:hover { background:rgba(96,165,250,.35); }
    .row-btn-export { background:rgba(124,58,237,.2); color:#c4b5fd; border:1px solid rgba(124,58,237,.3); }
    .row-btn-export:hover { background:rgba(124,58,237,.35); }
    .row-btn-delete { background:rgba(239,68,68,.15); color:#fca5a5; border:1px solid rgba(239,68,68,.25); }
    .row-btn-delete:hover { background:rgba(239,68,68,.3); }

    .empty-state { text-align:center; padding:60px 24px; }
    .empty-icon  { font-size:42px; margin-bottom:14px; }
    .empty-title { font-size:15px; font-weight:700; color:#e2e8f0; margin-bottom:6px; }
    .empty-sub   { font-size:12px; color:#64748b; line-height:1.7; }
  </style>
  </head><body>
  <div class="header">
    <div class="header-logo">${LOGO_SVG}</div>
    <div class="header-text">
      <h1>QA Super Agent</h1>
      <p>Saved Results &nbsp;·&nbsp; ${records.length} ${records.length === 1 ? 'result' : 'results'} stored locally</p>
    </div>
  </div>
  <div class="toolbar">
    <button class="tb-btn tb-btn-sec" onclick="doImport()">⬇ Import Result…</button>
  </div>
  <div class="results-list">${rows}</div>
  <script>
    const vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;
    function doLoad(id)   { if (vscodeApi) vscodeApi.postMessage({ command:'load',   id }); }
    function doExport(id) { if (vscodeApi) vscodeApi.postMessage({ command:'export', id }); }
    function doDelete(id) { if (confirm('Delete this result?')) { if (vscodeApi) vscodeApi.postMessage({ command:'delete', id }); } }
    function doImport()   { if (vscodeApi) vscodeApi.postMessage({ command:'import' }); }
  </script>
  </body></html>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collapsibleSection(icon, title, count, bodyHtml, defaultOpen, delay) {
  const countBadge = count !== '' ? `<span class="count">${count}</span>` : '';
  return `
  <div class="section" style="animation-delay:${delay || '0s'}">
    <div class="section-header ${defaultOpen ? 'open' : ''}">
      <span class="icon">${icon}</span>
      <span>${title}</span>
      ${countBadge}
      <span class="chevron">▼</span>
    </div>
    <div class="section-body ${defaultOpen ? 'open' : ''}">
      ${bodyHtml}
    </div>
  </div>`;
}

function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { activate, deactivate };
