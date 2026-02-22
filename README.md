<div align="center">

# RippleCheck

### See the blast radius of every code change — before you merge.

A VS Code extension that builds a live dependency graph of your TypeScript codebase and instantly shows which symbols, modules, and callers are impacted by any change — whether already staged in git or still just an idea.

<!-- TODO: Replace with actual screenshot/GIF -->
<!-- ![RippleCheck Demo](media/demo.gif) -->

</div>

---

## The Problem

In real-world software systems, even a small change — adding a field to an API, modifying a validation rule, or refactoring a shared utility — can silently break downstream services, data flows, and business logic. Today, engineers rely on tribal knowledge and manual inspection to estimate which parts of the system a change will affect. This makes impact assessment slow, error-prone, and invisible — turning every code review and deployment into a gamble.

## Our Solution

RippleCheck performs **deterministic, semantic static analysis** using the TypeScript type checker (via ts-morph) to build a bidirectional dependency graph of every symbol in your project. When you stage changes in git or describe a planned change in natural language, it runs a **multi-source BFS traversal** on the reverse graph to compute the full blast radius — every directly and transitively impacted symbol, with explanation paths and reason tags.

- **No regex. No string matching.** Every relationship is resolved through the TypeScript compiler's type checker.
- **Zero config. No external services.** Runs entirely inside VS Code — no API keys, no servers, no CLI tools.
- **Predictive analysis.** Describe a change you haven't written yet ("What if I delete the auth middleware?") and see its impact instantly, powered by VS Code's built-in Copilot LLM.

---

## Key Features

- **Real-time blast radius on staged changes** — `git add` a file and see every affected symbol, classified as direct or indirect, with depth tracking and explanation chains
- **"What If?" predictive analysis** — describe a planned change in plain English; an LLM parses the intent, a fuzzy resolver matches real symbols, and BFS computes the predicted impact with confidence scores
- **Live in-editor impact detection** — signature changes and symbol deletions are detected as you type (before `git add`), triggering instant blast radius computation
- **Interactive dependency graph** — full-project Cytoscape.js graph with color-coded nodes (red = changed, yellow = direct impact, amber = indirect, gray = unaffected) and a Full/Session toggle
- **Smart caching** — per-file SHA-1 hashes detect staleness on startup; only changed files are re-analyzed, never a full re-parse after first load
- **Explanation paths** — every impacted symbol includes a human-readable chain (e.g. `validateInput → processOrder → handleCheckout`) and a reason tag (`signature-ripple`, `body-change`, `deleted`, `renamed`)

---

## How It Works

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  tsconfig    │────▶│  ts-morph AST    │────▶│  Symbol Index        │
│  .json       │     │  parsing         │     │  (8 kinds extracted) │
└─────────────┘     └──────────────────┘     └────────┬────────────┘
                                                       │
                    ┌──────────────────┐     ┌─────────▼───────────┐
                    │  Reverse-edge    │◀────│  Reference Walker   │
                    │  BFS traversal   │     │  (full AST + type   │
                    │                  │     │   checker resolve)  │
                    └────────┬─────────┘     └─────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │  Blast Radius Result         │
              │  roots · direct · indirect   │
              │  depthMap · explanation paths │
              └──────────────┬───────────────┘
                             │
              ┌──────────────▼──────────────┐
              │  VS Code Sidebar + Graph     │
              │  Cytoscape.js visualization  │
              └──────────────────────────────┘
```

### Pipeline in detail

1. **Index** — ts-morph parses every source file via `tsconfig.json`. Eight symbol kinds are extracted (functions, classes, interfaces, types, enums, variables, methods, properties), each with a SHA-256 **signature hash** of its normalized public API surface (parameter types, return types, sorted union/intersection members).

2. **Graph** — A recursive AST walk with an owner stack resolves every identifier to its declaration via the TypeScript type checker. The result is a bidirectional adjacency map (`Map<string, Set<string>>`) with O(1) forward and reverse lookups. No third-party graph library is used.

3. **Detect** — On `git add`, the staging area is read via `git show :path` (not the filesystem — handles partial staging correctly). Changed symbols are classified:
   - **Signature ripple** (public API changed) → deep propagation (unlimited BFS)
   - **Body change** (implementation only) → shallow propagation (depth 1)
   - **Deleted / Renamed** → deep propagation

4. **Traverse** — Per-root BFS on the reverse graph, with independent parent maps per root for full path reconstruction. A symbol reachable from multiple roots retains all explanation paths.

5. **Display** — Results are pushed to the sidebar panel (changed symbols, direct/indirect impact, reason tags, explanation chains, changed files list) and the Cytoscape.js graph panel (color-coded, interactive, Full/Session toggle).

### What If? Pipeline

```
User prompt → LLM intent parsing → Fuzzy symbol resolution → Virtual diff → BFS → Confidence map
```

The LLM receives the full symbol index as grounding context (capped at 400 symbols) so it can only suggest names that actually exist in the codebase. A relevance gate rejects prompts foreign to the repo. Confidence scores degrade with graph distance from the root (`high` at depth ≤1, demoted one tier at depth ≥2).

---

## Architecture

| Layer | Key Files | Responsibility |
|-------|-----------|----------------|
| **Indexing** | `symbolExtractor` · `symbolIndex` · `referenceWalker` · `projectLoader` | Parse codebase via ts-morph, extract symbols with signature hashes, build bidirectional dependency graph |
| **Graph** | `types` · `graphStore` · `graphElements` | `DependencyGraph` (two `Map<string, Set<string>>`), O(1) edge queries, BFS traversal, Cytoscape element generation |
| **Analysis** | `signatureAnalyzer` · `blastRadiusEngine` | Signature change detection, multi-source BFS with depth tracking + path reconstruction, shadow-copy isolation |
| **Git** | `gitUtils` · `stagedSnapshot` · `stagedAnalyzer` · `diffParser` | Read staged content via `child_process.execFile`, parse diff hunks, map changed lines → symbols |
| **Intent** | `intentParser` · `intentResolver` · `predictiveEngine` · `virtualDiff` | LLM-powered intent parsing, fuzzy symbol matching (Jaccard + substring), synthetic root generation, confidence scoring |
| **Cache** | `cacheManager` · `cacheLoader` · `fileHashStore` | `.blastradius/` directory with 5 JSON files, per-file SHA-1 staleness detection, tsconfig hash for invalidation |
| **Watch** | `fileWatcher` · `incrementalUpdater` | Debounced editor edits, file create/delete/rename, external FS changes, git ref changes (HEAD, ORIG_HEAD, MERGE_HEAD, refs/heads/**) |
| **UI** | `panel` (sidebar) · `graphPanel` (Cytoscape) | Webview rendering, message passing, blast radius display, What If? interaction |

### Design Decisions

- **Shadow copies for staged analysis** — Staged analysis clones the symbol index and graph before mutating, so unstaging changes never corrupts live state.
- **Per-root BFS** — Each blast radius root gets its own parent map, enabling full path reconstruction even when the same symbol is reachable from multiple roots.
- **Signature hashing** — Public API fingerprints are whitespace-independent and sort union/intersection/object members, so semantically identical types always match regardless of formatting.
- **Incremental updates** — Only the edited file is re-parsed and re-walked. Full `rebuildInPlace` (with `setImmediate` yielding every 20 files) runs only on branch switch.

---

## Demo

<!-- TODO: Add screenshots after capturing -->

### Sidebar — Blast Radius Panel
<!-- ![Blast Radius Panel](media/screenshots/sidebar-blast-radius.png) -->
*Shows changed symbols, direct/indirect dependents with depth, explanation paths, and reason tags.*

### What If? — Predictive Analysis
<!-- ![What If Panel](media/screenshots/whatif-prediction.png) -->
*Describe a planned change in plain English → see predicted impact with confidence scores.*

### Graph View — Interactive Dependency Graph
<!-- ![Graph View](media/screenshots/graph-view.png) -->
*Full project dependency graph with color-coded blast radius overlay. Toggle between Full Graph and Session (impacted-only) views.*

---

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [VS Code](https://code.visualstudio.com/) (v1.108+)
- [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) extension (required for "What If?" — optional for staged analysis)

### Run the extension

```bash
# Clone the repository
git clone https://github.com/your-org/ripplecheck.git
cd ripplecheck

# Install dependencies
npm install

# Open in VS Code
code .
```

Then press **F5** to launch the Extension Development Host. Open any TypeScript project with a `tsconfig.json` — the RippleCheck sidebar activates automatically and begins indexing.

### Usage

1. **Staged blast radius** — Make changes, run `git add`, and click **Analyse** in the RippleCheck sidebar (or it triggers automatically on staging)
2. **What If?** — Type a planned change in the "What if…?" textarea (e.g. *"delete the cacheManager"*) and click **Predict Impact**
3. **Graph view** — Click **Open Graph View** to see the full interactive dependency graph

---

## Tech Stack

| Technology | Role |
|------------|------|
| **TypeScript** | Entire codebase — extension backend, analysis engine, UI |
| **ts-morph** | AST parsing, symbol resolution, type checker access |
| **VS Code Extension API** | Workspace lifecycle, file watchers, webview, command registration |
| **VS Code Language Model API** (`vscode.lm`) | Intent parsing via Copilot — no external API keys required |
| **Cytoscape.js** | Interactive graph visualization in webview |
| **child_process** (`execFile`) | Git operations (`diff --cached`, `show :path`) |
| **Node.js crypto** | SHA-256 signature hashes, SHA-1 file content hashes |

---

## Team DY

<!-- TODO: Add team member names and roles -->
- **[Dhivijit Koppuravui](https://github.com/dhivijit)**
- **[Yash Yashuday](https://github.com/heathKnowles/)**

---

<div align="center">
<sub>Built for the AI Buildathon - AIForVizag 2026</sub>
</div>