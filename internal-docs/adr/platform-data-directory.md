# Platform-Appropriate Data Directory

## Status

Accepted (commit `349f2f0`, April 2026).

## Context

Early versions of the tool stored the SQLite database, storage-state files, and certificate material under `./.csp-analyser/` relative to the current working directory. This worked when the tool was invoked from a project checkout during development but was unreliable once the tool began shipping as a globally installed CLI (`npm install -g @makerx/csp-analyser`):

- Users running `csp-analyser crawl` from their home directory would create a `~/.csp-analyser/` directory; from a project directory they would create a project-local one; from `/tmp` they would create one in `/tmp`. Sessions were effectively scattered across the filesystem with no way to find them again.
- The MCP server (which is launched by an agent, with a working directory the user has no real control over) had the same problem, magnified — agents would start the server from whatever CWD they happened to have, and session data ended up in unpredictable places.
- Users on shared machines could accidentally leak data into shared CWDs (e.g. a `~/workspace/` that is read-world).
- Windows users were particularly disadvantaged — dotfiles are a Unix convention; a hidden folder in the user's project folder is not idiomatic.

At the same time, we still wanted project-scoped sessions to be a useful concept (see [Project-Scoped Sessions](project-scoped-sessions.md)). The location of the data and the project tag on sessions are orthogonal concerns.

## Principles

- **Respect platform conventions** — use the OS's standard user-data location so the tool behaves like other CLIs users already trust
- **Predictable location** — a user should always be able to find their sessions regardless of where they launched the tool from
- **Single source of truth** — one database file per user, not per project directory
- **Not in `$HOME` dotfiles by default** — modern conventions have moved away from `~/.appname` for user data

## Requirements, Constraints, and Considerations

- Must resolve to the same path regardless of the process's current working directory
- Must respect `XDG_CONFIG_HOME` when set on Linux
- Must use `LOCALAPPDATA` on Windows
- Must use `~/Library/Application Support/` on macOS
- Must create the directory with secure permissions (`0o700`) on first use
- Must fall back gracefully if no environment variable resolves (e.g. headless CI without a home directory)
- Existing users with data under `./.csp-analyser/` should not have their data silently lost — but we accept a clean break because the pre-release user base is tiny

## Options

### Keep CWD-relative `./.csp-analyser/`

- No change
- Continues to break for globally installed CLI and MCP server use

### Always use `~/.csp-analyser/`

- Simple, cross-platform
- Clashes with modern conventions (XDG on Linux, Application Support on macOS); Windows users still get a Unix-style dotfolder
- Does not respect `XDG_CONFIG_HOME` for users who have configured it

### Platform-appropriate directory resolution

- Linux: `$XDG_CONFIG_HOME/csp-analyser` (defaulting to `~/.config/csp-analyser`)
- macOS: `~/Library/Application Support/csp-analyser`
- Windows: `%LOCALAPPDATA%\csp-analyser`
- Fallback: `~/csp-analyser`
- Implemented in a single helper (`getDataDir()` in `src/utils/file-utils.ts`) consumed by CLI, MCP server, and session manager

### Comparison

| Criterion | CWD-relative | `~/.csp-analyser/` | Platform-appropriate |
|-----------|--------------|--------------------|-----------------------|
| Works for global CLI | No | Yes | Yes |
| Works for MCP server from any CWD | No | Yes | Yes |
| Respects `XDG_CONFIG_HOME` | No | No | Yes |
| Idiomatic on macOS | No | No | Yes |
| Idiomatic on Windows | No | No | Yes |
| Implementation complexity | None | Trivial | ~20 LOC helper |

## Decision

Use **platform-appropriate directory resolution** via a single `getDataDir()` helper.

The resolution order is:

```
Windows:  %LOCALAPPDATA%\csp-analyser   →  %USERPROFILE%\csp-analyser
macOS:    ~/Library/Application Support/csp-analyser
Linux:    $XDG_CONFIG_HOME/csp-analyser →  ~/.config/csp-analyser
```

All callers (`src/cli.ts`, `src/mcp-server.ts`, `src/session-manager.ts`) consume this helper; no code path constructs the path independently. The directory is created lazily on first use with `0o700` permissions via the existing `ensureDataDirectory()` helper.

Note: the Linux path intentionally lives under `XDG_CONFIG_HOME` (not `XDG_DATA_HOME`) to keep the tool's single directory colocated with other developer CLIs that put their state under `~/.config/`. This is a minor deviation from the strict XDG spec that matches the actual ecosystem convention.

## Consequences

- Users who created sessions before this change have a stale `./.csp-analyser/` in their project directories; it is harmless and can be deleted manually. We do not auto-migrate because the pre-release user base is minimal
- The `.csp-analyser/` entry can be removed from the project's `.gitignore` in a follow-up — the tool no longer creates it in user projects
- Multi-user shared machines get correct per-user isolation by default
- CI runners may need `XDG_CONFIG_HOME` set to a workspace-scoped path so that sessions don't leak across builds; the fallback behaviour is safe but not ideal for CI

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| User loses sessions they created in a project directory | High (once, at upgrade) | Low | Pre-release user base; documented in release notes |
| CI jobs share a data directory between runs on the same runner | Medium | Low | Document `XDG_CONFIG_HOME` override; sessions are project-scoped so cross-contamination is limited |
| Permission errors on systems where the chosen path is not writable | Low | Medium | Fallback to `~/csp-analyser` on error; error messages surface the actual path being used |
| Windows user has neither `LOCALAPPDATA` nor a usable home directory | Very low | Medium | Fallback to `~/csp-analyser`; if that fails the tool errors clearly rather than silently picking CWD |
