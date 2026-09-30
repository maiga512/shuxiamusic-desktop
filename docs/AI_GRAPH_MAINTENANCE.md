# AI Graph Maintenance

This runbook is the detailed maintenance contract for Graphify and the AI search
index. The root `AGENTS.md` is the short mandatory rule; this document contains
the exact workflow.

## Invariants

- Keep `AI_INDEX.md`, `TOP_GRAPH.md`, `CONTEXT_HANDOFF.md`, and `graphify-out/`
  synchronized.
- Never modify the Electron reference project.
- Keep product behavior aligned with the Electron reference.
- Update the graph and tags in the same change session as the code or docs edit.
- Do not add Graphify as a runtime application dependency.

## Files Owned By This Process

| File | Purpose |
| --- | --- |
| `AGENTS.md` | Mandatory short contract for every AI agent. |
| `AI_INDEX.md` | Tags, aliases, routing, stats, maintenance log. |
| `TOP_GRAPH.md` | Curated architecture and cross-module flows. |
| `docs/AI_GRAPH_MAINTENANCE.md` | This runbook. |
| `graphify-out/graph.json` | Machine-readable graph. |
| `graphify-out/GRAPH_REPORT.md` | Generated audit report. |
| `graphify-out/graph.html` | Interactive graph. |
| `graphify-out/.graphify_labels.json` | Stable community names used by the report. |

## Code-Only Change Workflow

Use this for normal TypeScript, Vue, Rust, Node sidecar, script, or configuration
changes.

```bash
cd /Users/songsong/Movies/ceru-tauri

# Incremental AST update. No LLM is needed for code.
graphify update .

# Regenerate the browser view.
graphify export html
```

Then:

1. Confirm the graph update completed and record node/edge/community counts.
2. Update tags or routes in `AI_INDEX.md`.
3. Update `TOP_GRAPH.md` if the changed ownership, flow, god node, or execution
   path is now different.
4. Append a dated line to the `AI_INDEX.md` maintenance log.
5. Mention the graph update in the final work summary.

## Documentation Or HTML Change Workflow

Use this whenever Markdown, HTML, or other semantic source files change.

1. Read the current Graphify skill and update reference.
2. Run the incremental update first:

```bash
cd /Users/songsong/Movies/ceru-tauri
graphify update .
```

3. If the change affects semantic meaning, run the Graphify full extraction
   workflow from the installed graphify skill so the changed documents are
   processed by a semantic extraction agent. Do not hand-edit node IDs.
4. Rebuild the report, labels, and HTML using the same Graphify pipeline that
   created the original graph.
5. Update `TOP_GRAPH.md` for any changed architecture concept.
6. Update `AI_INDEX.md` and append the maintenance log entry.

The generated graph must match the documentation. A hand-edited graph without a
matching extraction record is not valid.

## Graphify Command Reference

The Graphify worker is recorded in:

```bash
cat graphify-out/.graphify_python
```

Use that interpreter when running the pipeline's Python steps. Useful commands:

```bash
# Incremental code update
graphify update .

# Re-run clustering only
graphify cluster-only .

# Query the graph
graphify query "Where is podcast first-screen loading controlled?"

# Explain a node and neighbors
graphify explain "createTauriBridge"

# Find a path
graphify path "PlayMusic.vue" "node_sidecar_request"

# Regenerate the interactive graph
graphify export html
```

If a command creates temporary `.graphify_*` files, follow the installed skill's
cleanup step before finishing.

## Tag Update Rules

Update `AI_INDEX.md` when any of these change:

- a user-facing term or Chinese alias;
- a primary entry-point file;
- the start-here route for a task;
- a command or service name;
- the ownership of a module;
- a top-level dependency or runtime boundary;
- a known graph-health caveat.

Use stable tags. Prefer terms an agent would search for directly:

- `playback`
- `source-switch`
- `quality`
- `download`
- `podcast`
- `discover`
- `desktop-lyric`
- `full-player`
- `memory`
- `sidecar`
- `plugin`
- `nas-sync`

## Top Graph Update Rules

Edit `TOP_GRAPH.md` only for meaningful architecture changes. Update it when:

- a god node is added, removed, or renamed;
- a main community changes responsibility;
- a cross-community flow changes;
- a Tauri command or sidecar service is added;
- the Electron parity boundary changes;
- the playback, podcast, lyric, download, source, or persistence path changes;
- the suggested query list becomes misleading.

Do not paste the full generated report into `TOP_GRAPH.md`. Keep it curated and
small enough for an agent to read before opening source files.

## Verification Checklist

Before finishing a change:

```bash
python3 -m json.tool graphify-out/graph.json >/dev/null
python3 -m json.tool graphify-out/.graphify_labels.json >/dev/null
test -s graphify-out/graph.html
```

Also check:

- `AI_INDEX.md` last-indexed date and maintenance log.
- `TOP_GRAPH.md` still points to existing files.
- `CONTEXT_HANDOFF.md` is not contradicted by the new graph.
- The final response states what was re-indexed.

## Failure Recovery

If Graphify cannot update:

1. Do not claim the index is current.
2. Preserve the existing `graph.json`, report, labels, and HTML.
3. Record the failed command and reason in the final response.
4. If the change is code-only, verify the source manually and leave a clear
   maintenance log note saying the graph update is pending.
5. Never replace a valid graph with an empty or partial extraction.

