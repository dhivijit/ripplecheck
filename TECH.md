# TECH.md

## Runtime Environment

**Primary Runtime:** Node.js (runs inside VSCode Extension Host)

Reason:
The analyzer executes as part of a VSCode extension backend process.
No external services, servers, or CLI binaries are required.

---

## Language

**Implementation Language:** TypeScript

Used for:

* extension backend
* AST analysis engine
* dependency graph
* caching
* IPC communication
* UI messaging contracts

---

## Core Technologies

### VSCode Extension API

Purpose: Host and lifecycle control

Responsibilities:

* workspace activation
* file system watching
* SCM/git integration triggers
* Webview UI communication
* command registration
* user decision handling

The extension is the entrypoint of the entire system.

---

### ts-morph

Purpose: Static code analysis

Provides:

* AST parsing
* symbol resolution
* type checker access
* reference finding
* import resolution

Used to extract:

* functions
* classes
* interfaces
* exports
* type relationships
* call relationships

All structural understanding originates from ts-morph.

---

### TypeScript Compiler API (via ts-morph)

Purpose: True semantic relationships

Used for:

* resolving actual symbol references
* detecting signature changes
* identifying return type propagation
* distinguishing type usage vs runtime usage

No regex or text-based parsing is allowed.

---

### Custom Adjacency Map

Purpose: Dependency graph storage and traversal

Implemented with two plain `Map<string, Set<string>>` structures (forward and reverse).
No third-party graph library is used.

Stores directed graph:

```
dependent → dependency
```

Supports:

* O(1) forward and reverse edge lookup
* BFS blast radius traversal with depth tracking
* path tracing

Graph exists entirely in memory and is mirrored to disk cache.

---

### child_process (Node built-in)

Purpose: Read staged changes from repository

Git is invoked directly via `child_process.execFile` — no wrapper library.

Used commands:

```
git diff --cached --name-status
git show :<relpath>
```

Provides:

* staged file list with M/A/D/R/C status codes
* exact staged file content (byte-accurate, before commit)

Git is only a data source — not an execution environment.

Note: `simple-git` is also in the dependency tree but is used only in the legacy
webview commit-history display. All staged analysis uses `child_process.execFile` directly.

---

### File System APIs (VSCode workspace.fs + Node fs)

Purpose: Cache and workspace monitoring

Used for:

* storing graph cache
* storing symbol index
* detecting structural project changes

---

## UI Layer

### VSCode Webview

Purpose: Display analysis results

The UI never performs analysis.

Responsibilities:

* render graph
* display impacted symbols
* display severity
* return user decision

---

### Cytoscape.js

Purpose: Graph visualization

Used only in Webview.

Displays:

* nodes = symbols
* edges = dependencies
* colors = risk level

No analysis logic inside UI.

---

## Storage

### Local Cache Directory

```
.blastradius/
    graph.json        — serialized forward + reverse dependency maps
    symbols.json      — full symbol index (id → SymbolEntry)
    signatures.json   — per-symbol signature hashes for change detection
    fileHashes.json   — per-file sha1 hashes for staleness detection on startup
    metadata.json     — project hash (tsconfig sha256) + last-built timestamp
```

On startup, per-file hashes are compared to identify stale files.
Only stale files are re-analyzed; the rest are loaded from cache.
This prevents a full reparse after routine workspace opens.

---

## Event Sources

### Workspace Events

Triggered by VSCode:

* workspace open
* folder added
* file edit
* file delete
* file create

Used to maintain incremental graph updates.

---

### Git Events

Two distinct git event sources:

**Ref file changes** (watched via `vscode.workspace.createFileSystemWatcher`):

* `.git/HEAD` — branch checkout, switch
* `.git/ORIG_HEAD` — reset --hard, pre-merge state
* `.git/MERGE_HEAD` — in-progress merge
* `.git/FETCH_HEAD` — after fetch / pull
* `.git/refs/heads/**` — plain `git commit` on non-detached HEAD

Any of these triggers a full in-memory graph rebuild (`rebuildInPlace`).

**Staged diff** (on demand or post-commit):

* `git diff --cached --name-status` enumerates staged files
* `git show :<relpath>` reads exact staged content per file
* Staged content is fed into the incremental updater to compute which symbols changed

Used to compute blast radius.

---

## Processing Pipeline

**Startup**

1. Workspace loads; extension activates
2. Cache directory and files initialized
3. `tsconfig.json` hashed; per-file hashes compared against `fileHashes.json`
4. Cache hit: only stale files re-analyzed and patched into existing graph
5. Cache miss: full project parse with ts-morph; symbol index + graph built from scratch
6. File watcher registered for editor edits, file system events, and git ref files

**Incremental updates (continuous)**

7. File edit / save → ts-morph re-parses that file → symbol index and graph edges updated in place
8. Git ref change (checkout, commit, merge, reset) → full `rebuildInPlace` with status bar feedback

**Blast radius analysis (on demand or post-commit)**

9. Staged diff retrieved via `git diff --cached --name-status` + `git show :<path>`
10. Staged content fed into incremental updater; changed/added/removed/renamed symbols identified
11. Signature hashes compared → `rippleRoots` (symbols whose public API changed)
12. BFS traversal of reverse graph from each root → `BlastRadiusEntry[]` with depth per symbol
13. Structured result sent to Webview panel
14. VS Code Language Model API (`vscode.lm`) called with changed + impacted symbol list → textual summary streamed to panel
15. Full project graph rendered; blast radius nodes color-coded by depth

---

## Performance Strategy

Key requirement: avoid full reparse.

Techniques used:

* ts-morph project reuse
* per-file reanalysis
* adjacency graph updates
* persistent cache
* reverse dependency traversal only

---

## UI Layer — LLM Integration

### VSCode Language Model API (`vscode.lm`)

Purpose: Generate human-readable blast radius summaries

Used to produce a 2–3 sentence risk description for the code reviewer.
Requires no API key — uses the model already available through the user’s Copilot subscription.

Called after blast radius computation completes. The prompt includes:

* list of changed symbols (name, kind, file)
* list of transitively impacted symbols (name, depth, file)

The response streams into a summary card at the top of the Webview panel.

---

## Non-Used Technologies (Explicitly Out of Scope)

The system intentionally does NOT use:

* runtime execution
* test runners
* language servers
* AST string parsers
* Babel / SWC / ESLint analyzers
* external LLM APIs (OpenAI, Anthropic) — `vscode.lm` is used instead
* external databases
* remote services

All structural analysis is local and deterministic.
The LLM is additive (summary only) and never influences the graph or impact classification.

---

## Result

The system maintains a continuously updated static dependency graph and performs deterministic structural impact analysis using semantic TypeScript relationships. After each commit or on demand, it computes the blast radius of staged changes and surfaces both a visual graph and an LLM-generated risk summary to the developer.
