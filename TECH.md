Below is a **machine-consumable technical spec** you can hand to Copilot/agents.
It intentionally avoids product language and focuses on *what to build and how it behaves*.

---

# BlastRadius — Technical Specification

## Goal

Implement a local analysis system that determines the structural impact of staged git changes before a commit.

The system must:

1. Read staged changes
2. Map changes to code symbols
3. Traverse dependency relationships
4. Classify impact
5. Produce structured output
6. Allow commit or abort based on user decision

The system analyzes static structure only.
No runtime execution, no test execution, no behavioral prediction.

---

## Target Environment

* Local developer machine
* Git repository
* TypeScript / Node.js codebases
* Runs through git pre-commit hook
* Communicates with VSCode extension UI

---

## Technology Stack and Responsibilities

### Runtime

Node.js

Purpose:

* Execute analyzer CLI
* Parse AST
* Traverse graph
* Produce report

---

### Git Integration

simple-git

Purpose:
Extract staged changes:

```
git diff --cached
git diff --cached --name-only
```

Output required:

* changed files
* changed line ranges

---

### Code Understanding

ts-morph

Purpose:
Convert source files into structured symbol graph.

Required extraction:

Symbols:

* Function declarations
* Methods
* Classes
* Interfaces
* Exported members

Relationships:

* Function calls
* Imports
* Parameter types
* Return types
* Type references

The parser must resolve references, not string match.

---

### Graph Representation

graphlib (or adjacency map)

Purpose:
Store dependency relationships and enable traversal.

Graph characteristics:
Directed graph

Edge direction:
Dependent → Dependency

Example:
controller → service → repository

Required operations:

* upstream traversal (who depends on changed node)
* downstream traversal (what changed node depends on)
* path tracing

---

### Cache

Local JSON files

Purpose:
Avoid rebuilding graph on every commit.

Stored data:

* symbol index
* dependency graph
* previous analysis timestamp

Graph rebuild occurs only when project files change structurally.

---

### Impact Engine

Custom logic

Purpose:
Given changed symbols, compute blast radius.

Algorithm:

1. Identify changed symbols
2. Traverse reverse dependency edges
3. Collect reachable nodes
4. Categorize distance
   depth = 1 → direct impact
   depth > 1 → indirect impact

Output:
list of impacted symbols with path traces

---

### Risk Classifier

Rule-based engine

Purpose:
Assign severity level.

Rules:

HIGH

* exported function modified
* API route affected
* return type changed
* shared utility used by multiple modules

MEDIUM

* internal module dependency affected

LOW

* private function only

NONE

* test-only changes

---

### Output Format

JSON (structured, deterministic)

Example:

```json
{
  "change": {
    "symbol": "getUser",
    "type": "function",
    "changeType": "signature"
  },
  "risk": "HIGH",
  "directImpact": [
    "userController"
  ],
  "indirectImpact": [
    "authMiddleware",
    "sessionService"
  ],
  "paths": [
    ["userController", "getUser"],
    ["authMiddleware", "userController", "getUser"]
  ],
  "reason": "Return type propagates into API response"
}
```

No natural language generation required in core analyzer.

---

### VSCode Communication

IPC between analyzer and extension

Purpose:

* Trigger analysis
* Receive result
* Show UI
* Send user decision

Analyzer must block until decision received.

Return codes:

0 → allow commit
1 → abort commit

---

### Visualization

Webview + Cytoscape.js

Purpose:
Render graph using analysis output.

Nodes colored by risk level.

No analysis logic in UI layer.

---

## Execution Flow

1. Git pre-commit hook runs analyzer CLI
2. CLI reads staged diff
3. Changed lines mapped to symbols
4. Graph loaded from cache or rebuilt
5. Impact traversal performed
6. Risk classification applied
7. JSON report generated
8. Sent to VSCode
9. User decision returned
10. Hook exits with status

---

## Performance Constraints

After initial graph build:

analysis time < 1 second

Requirements:

* no full project reparse each commit
* incremental symbol mapping
* cached graph traversal only

---

## Non-Goals

* No runtime simulation
* No test execution
* No AI-based dependency inference
* No multi-language support
* No repository-wide refactor suggestions

---

## Expected Behavior

Given a staged change, the system deterministically outputs:

* impacted components
* impact depth
* risk severity
* reasoning path

The output must be explainable by graph relationships only.
