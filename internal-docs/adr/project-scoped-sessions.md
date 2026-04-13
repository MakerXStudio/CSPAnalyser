# Project-Scoped Sessions with Auto-Resolution

## Status

Accepted (commit `082409f`, April 2026).

## Context

The tool persists all sessions in a single SQLite database (see [Platform-Appropriate Data Directory](platform-data-directory.md)). Every `crawl` or `interactive` run creates a new session row; downstream commands (`generate`, `export`, `score`, `permissions`, `diff`) all accept a `<session-id>` argument.

Two friction points showed up as the tool moved to real use:

1. **Finding the right session ID is tedious.** A user runs `csp-analyser crawl https://myapp.local`, sees a UUID in the output, and then has to copy-paste it into a second command to export or score. For a rapid iteration loop ("crawl → inspect policy → change strictness → re-export") this is constant friction.
2. **Sessions from unrelated projects pile up in the same listing.** Because all data lives in one global DB, `csp-analyser sessions` shows every session the user has ever run, across every project. A user working on `project-a` does not want to dig through sessions from `project-b` to find the last one they care about.

Two orthogonal ideas solve this:

- **Project tagging.** Attach a project identifier to each session when it is created, derived from something stable about the user's CWD.
- **Auto-resolution.** When a session ID is not provided, pick the most recent successful session automatically — scoped to the current project.

## Principles

- **Optimise for the inner loop** — the common case of "apply the last result" should be one command without copying UUIDs
- **Do not silently pick the wrong session** — auto-resolution must be scoped tightly enough that it can only pick something the user meant
- **Explicit beats implicit for cross-project** — if the user passes a session ID, use it exactly; do not second-guess

## Requirements, Constraints, and Considerations

- Must tag each session with a stable identifier tied to the user's project
- Must auto-resolve to "the most recent completed session in this project" when a session argument is omitted
- Must not auto-resolve across projects — a user in `~/work/project-a` should not inherit a session from `~/work/project-b`
- Must continue to accept explicit session IDs unchanged
- Must work in both CLI and MCP contexts
- Must not require the user to manually name projects
- Must handle the "no project detected" case gracefully (e.g. the user runs the tool from a directory that has no `package.json`)

## Options

### Manual project flag

- Add a `--project <name>` flag and require users to set it
- Too much ceremony; users will forget or set it inconsistently

### Detect project from `package.json` `name`

- Walk upwards from CWD until a `package.json` is found; use its `name` field
- Stable, predictable, and matches how most JS tooling locates project root
- Falls back to the basename of CWD (or `default`) when no `package.json` is found

### Detect project from git repository root

- Find the enclosing `.git/` directory; use the repo name or the remote URL
- Works for non-JS projects but adds complexity and fails outside git repositories
- Overkill for a tool whose primary users ship web apps (which almost always have a `package.json`)

### Content-hash of CWD path

- Use a hash of the CWD itself as the project ID
- Avoids name collisions but is opaque to users and breaks if they move the project directory

### Chosen approach

- **Project ID:** walk upwards from CWD looking for `package.json`; use its `name` field. If none is found, fall back to the basename of CWD, then to `default`.
- **Auto-resolution:** commands that take `<session-id>` accept it as optional; when omitted, the repository looks up the most recent session whose `status = 'completed'` and whose `project_name` matches the current project, and uses that.
- **Sessions listing:** `csp-analyser sessions` defaults to the current project; a `--all` flag shows every session across every project.

### Comparison

| Criterion | Manual flag | `package.json` name | Git root | CWD hash |
|-----------|-------------|---------------------|----------|----------|
| Zero-config | No | Yes | Yes (in git) | Yes |
| Works for non-JS projects | Yes | Fallback to CWD basename | Yes | Yes |
| Works outside git | Yes | Yes | No | Yes |
| Matches user's mental model | Yes | Yes | Yes | No |
| Stable across directory renames | Yes | Yes (uses `name`) | Yes | No |
| Implementation complexity | Trivial | Small (upward walk) | Small (git detection) | Trivial |

## Decision

**Project identifier** — walk upward from CWD for a `package.json`; use its `name` field. Fall back to `path.basename(cwd)`, then to `default`.

**Schema** — add a `project_name` column on `sessions`, indexed for fast lookup. Populated at session creation; never mutated afterwards.

**Auto-resolution** — `generate`, `export`, `score`, and `permissions` accept the session ID as optional. When omitted, the CLI calls `repository.getLatestCompletedSessionForProject(projectName)`. If that returns nothing, the CLI errors with guidance ("no completed session found for this project; run `csp-analyser crawl <url>` first or pass a session ID").

**Sessions listing** — `csp-analyser sessions` filters to the current project by default. `--all` removes the filter.

**Diff** — the `diff <id-a> <id-b>` command remains fully explicit — auto-resolution is not applied because a diff between two unspecified sessions is meaningless.

## Consequences

- Users can run `csp-analyser crawl https://app.local && csp-analyser export --format nginx` in a project directory and get the expected result without copying IDs
- Cross-project sessions require either `--all` on listing or an explicit session ID on downstream commands — this is an intentional safety net, not a bug
- MCP callers receive the same auto-resolution behaviour; agents that track session IDs explicitly are unaffected because the parameter is still accepted when provided
- The project detection walks filesystem upwards on every session-creating command — negligible cost, runs once per invocation
- `project_name` is user-supplied content from `package.json`; we treat it as opaque text and never interpolate it into SQL (parameterised queries) or into filesystem paths

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Two unrelated projects share the same `package.json` name | Low | Low | Cross-contamination is bounded to auto-resolution; explicit session IDs still work. User can pass `--all` on listing to see everything |
| User renames a `package.json` `name` mid-project | Low | Low | Old sessions become invisible to auto-resolution but are still queryable via `--all` and explicit IDs; no data loss |
| A workspace monorepo picks up the wrong package on upward walk | Medium | Low | Upward walk stops at the first `package.json`, which is typically the workspace root or the workspace package the user is in. Good enough; users with strong opinions can pass an explicit session ID |
| `project_name` from user-controlled `package.json` contains unusual characters | Low | Low | Stored as-is; queries are parameterised. Only surfaces in the sessions listing where any string is acceptable |
