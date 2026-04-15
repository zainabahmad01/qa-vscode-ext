# QA Super Agent

**AI-powered QA test case generation, failure prediction, and code issue detection — right inside VS Code and Cursor.**

Powered by Google Gemini (free tier). Each user provides their own API key — nothing is shared or stored on any server.

---

## Features

- **Interactive tutorial** — guided onboarding walks you through setup step by step (auto-shown on first install)
- **Dark, animated UI** — elegant dark theme with smooth animations and a prominent branded logo
- **Generate complete test cases** from a feature description, selected code, or your entire workspace
- **Predict real-world failures** before they reach production
- **Detect code issues** in Flutter (Dart), PHP (CodeIgniter), and Node.js
- **Coverage report** — functional, negative, edge, UI, and API coverage
- **Local data storage** — every analysis is automatically saved to your machine; browse, reopen, or delete past results at any time
- **Offline result viewing** — previously saved results can be opened without any internet connection or running backend
- **Data sharing** — export any saved result as a portable `.qa.json` file and import results shared by teammates
- **Secure API key storage** — your Gemini key is stored in VS Code's encrypted secret store, never in plain settings

---

## Local Company Project Workflow

Use QA Super Agent to run and iterate on an existing company codebase locally:

- **Clone and run locally** — open the cloned repository in VS Code and run QA flows on your machine
- **Code integration support** — integrate provided implementation snippets into your local workspace
- **Figma description parsing** — feed Figma text descriptions and map them to implementation updates
- **PRD-driven execution** — align generated QA scenarios and checks with PRD requirements
- **Missing-file handling** — detect incomplete project state and surface actionable error messaging
- **Instant design updates** — re-run analysis to reflect design updates immediately in generated outputs
- **Login-aware flow** — if the target project includes auth, QA workflows can include login-required coverage

---

## Quick Start

### 1. Install the extension
Install from the VS Code Marketplace by searching **"QA Super Agent"**.

A built-in tutorial opens automatically on first install — follow it for guided setup.

### 2. Start the backend server
The extension talks to a local Python backend. Run it once:

```bash
cd /path/to/qa_agent
pip install -r requirements.txt
uvicorn api:app --reload --port 8000
```

### 3. Set your free Gemini API key
Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — no billing needed.

On first use, the extension will prompt you to paste it. It is stored securely and never leaves your machine.

### 4. Run QA analysis
- **Keyboard shortcut**: `Cmd+Shift+Q` (Mac) / `Ctrl+Shift+Q` (Windows/Linux)
- **Command Palette**: `QA: Generate Test Cases & Failure Analysis`
- **Right-click** selected code → `QA: Generate Test Cases & Failure Analysis`

---

## Tutorial

An interactive step-by-step tutorial is shown automatically on first install. To reopen it at any time:

- **Command Palette** → `QA: Show Tutorial`

The tutorial covers: getting an API key, starting the backend, running your first analysis, and understanding the results panel.

---

## Local Storage & Offline Usage

Every time you run an analysis, the result is **automatically saved to your local machine** in VS Code's global storage directory. No manual action needed.

- Browse all saved results via `QA: View Saved Results`
- Open any past result instantly — **no internet or backend required**
- Delete results you no longer need

### Data Sharing

Share QA results with your team without any server:

1. Open `QA: View Saved Results` (or use `QA: Export Result to File`)
2. Click **⬆ Export** next to any result to save it as a `.qa.json` file
3. Send the file to a teammate; they import it via `QA: Import Result from File`

---

## Commands

| Command | Description |
|---|---|
| `QA: Generate Test Cases & Failure Analysis` | Main command — analyzes selection or full workspace |
| `QA: View Saved Results` | Browse, open, export, or delete locally saved results |
| `QA: Export Result to File` | Export a saved result as a shareable `.qa.json` file |
| `QA: Import Result from File` | Import a `.qa.json` file shared by a teammate |
| `QA: Show Tutorial` | Open the interactive onboarding tutorial |
| `QA: Set / Change Gemini API Key` | Update your saved API key |
| `QA: Clear Saved API Key` | Remove your stored key |
| `QA: Open Settings` | Configure server URL and model |

---

## Output

The extension opens a dark-themed side panel with:

- **Summary** — what was analyzed
- **Test Scenarios** — high-level test areas
- **Test Cases** — full structured cases with steps, expected results, priority, severity (filterable by type)
- **Predicted Failures** — likely bugs with root cause and trigger conditions
- **Code Issues** — frontend and backend code smells
- **Coverage Report** — functional / negative / edge / UI / API

All sections are collapsible. Metric cards at the top show total, high, medium, and low priority counts at a glance.

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `qaAgent.serverUrl` | `http://localhost:8000` | URL of the QA backend server |
| `qaAgent.model` | `gemini-2.0-flash` | Gemini model to use |

Your API key is **not** a setting — it is stored securely via VS Code's secret API.

---

## Supported Languages / Stacks

- **Flutter** (Dart) — UI interactions, API calls, form handling, navigation
- **PHP** (CodeIgniter) — controllers, validation, DB queries, API responses
- **Node.js / TypeScript** — routes, middleware, error handling, DB calls

---

## Privacy

- Your code is sent only to the Google Gemini API using **your own API key**
- The local backend server runs on your machine — no third-party servers
- Your API key is stored in VS Code's encrypted secrets, never in plain text

---

## License

MIT
