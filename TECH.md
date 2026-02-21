Below is a clean **TECH.md** — not marketing, not architecture theory — just the concrete stack, libraries, and what each part is responsible for so an engineer immediately understands *what technologies exist in the repo and why*.

You can drop this directly into the project root.

---

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

### graphlib (or custom adjacency map)

Purpose: Dependency graph storage and traversal

Stores directed graph:

```
dependent → dependency
```

Supports:

* reverse traversal (blast radius)
* depth calculation
* path tracing

Graph exists entirely in memory and is mirrored to disk cache.

---

### simple-git (or child_process git)

Purpose: Read staged changes from repository

Used commands:

```
git diff --cached --unified=0
git diff --cached --name-only
```

Provides:

* changed files
* changed line ranges

Git is only a data source — not an execution environment.

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
    graph.json
    symbols.json
    metadata.json
```

Contains:

* dependency graph
* symbol index
* project hash

Cache prevents full rebuild on every workspace open.

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

Triggered by user actions:

* staging files
* manual analysis command

Used to compute blast radius.

---

## Processing Pipeline

1. Workspace loads
2. Project parsed with ts-morph
3. Graph built and cached
4. File changes update graph incrementally
5. Git staged diff retrieved
6. Changed lines mapped to symbols
7. Graph traversed
8. Impact classified
9. Structured result sent to UI
10. User decision returned

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

## Non-Used Technologies (Explicitly Out of Scope)

The system intentionally does NOT use:

* LLMs
* runtime execution
* test runners
* language servers
* AST string parsers
* Babel / SWC / ESLint analyzers
* external databases
* remote services

All analysis is local and deterministic.

---

## Result

The system forms a continuously maintained static dependency graph and performs deterministic structural impact analysis using only semantic TypeScript relationships.

---

If you want, next we should write **ARCHITECTURE.md** — that’s where we define modules and boundaries (AnalyzerEngine, GraphStore, SymbolIndex, ImpactService, etc.). That file is what makes contributors not destroy the design later 😄
