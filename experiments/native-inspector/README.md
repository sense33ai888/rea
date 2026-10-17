# macOS native hierarchy companion (fork-only, opt-in)

This companion adds the bounded internal AppKit inspection used during a native
design investigation: visible `NSView` and `CALayer` trees, geometry, clipping,
mask references, `NSVisualEffectView` material/blending/state, and public native
glass properties. It is **not upstream REA**, not its accessibility observer,
and does not produce REA Evidence records. It is not enabled by `rea setup` or
included in REA's npm package. Existing REA registrations are left unchanged.

## Contents and requirements

- `mcp.mjs`: separate stdio MCP server with capture and retained-page tools.
- `native_hierarchy.py`: LLDB attach, main-thread collection, detach and resume.
- `native-hierarchy-probe.m` / `native_hierarchy.expr`: bounded Objective-C probe.
- `build.mjs`: compile the probe, self-owned AppKit fixture and REA's existing
  `bridge/process/ProcessRunTokenReader*.swift` identity helper.
- `verify.mjs`: real independent stdio MCP acceptance, optionally with the fixture.
- `test.mjs` / `test_lifecycle.py`: schema, selection, coverage, completion-gate
  and controlled cleanup regressions. Python mocks are not real-provider evidence.
- `decompile-smoke.c`: the small native decompilation fixture used separately
  to check the bring-your-own Ghidra installation.

Use the repository's locked Node/dependencies (`npm ci`) and macOS with Xcode
command-line tools. Building glass support requires a macOS 26+ SDK. Runtime
glass queries are guarded by OS availability. Real verification so far is macOS
27 arm64, Node 24.19, SDK 27; other hosts remain unverified. No new npm dependencies.
Java/Ghidra remain bring-your-own: see [installation](../../docs/installation.md).
No application, SDK, JDK, Ghidra distribution, capture, credentials or debug
binary belongs in Git. Local build/capture/report output is ignored.

## Build and verify without a third-party application

From the repository root:

```sh
npm run test:native-inspector
npm run verify:native-inspector
```

The portable regressions also run through the existing `test:python` CI/check:pr
lane. Real AppKit capture remains an explicit macOS verification command, not a
claim that Linux CI exercised LLDB or the active agent.

The second command compiles and launches **only the self-owned fixture**, waits
for its readiness marker, starts a separate MCP SDK client, captures the real
window, verifies frame `(8,8,280,440)`, material 21, blending 0, state 1, radius
17 and clipping, rejects an invalid capture ID, and checks the target resumed.
It then closes MCP and terminates/waits for only the fixture process it launched.
It never launches, terminates or changes an installed application. Report:
`acceptance-transport.json`. A fixture result is not evidence about another app.

## Inspect an explicitly approved local debug copy

Prepare and launch the debug copy separately, under the owner's approval. Its
signing/debug entitlements must permit LLDB attach and loading the local probe.
System accessibility permission alone does not establish either capability.
Do not modify an installed app or disable global security to make this work.
The server does not copy, sign or launch apps, change entitlements, send messages,
click UI, edit workspaces or use the network. The target app can still perform
its own normal writes/network work, including while the debugger evaluates code.

```sh
node experiments/native-inspector/build.mjs
```

Register the separate server using your client's project-scoped MCP settings.
Substitute real absolute paths and the current debug executable's SHA-256:

```toml
[mcp_servers.rea_native]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/rea/experiments/native-inspector/mcp.mjs"]
startup_timeout_sec = 30
tool_timeout_sec = 90
enabled = true

[mcp_servers.rea_native.env]
REA_NATIVE_EXECUTABLE = "/absolute/workspace/Example-debug.app/Contents/MacOS/Example"
REA_NATIVE_EXECUTABLE_SHA256 = "replace-with-the-64-character-sha256-of-that-executable"
```

Keep unrelated MCP entries. Registration is manual and opt-in; no global config
edits are needed. Executable paths are canonicalized and installed `/Applications`
or `/System` targets are rejected. A hash mismatch requires an explicit review
of the changed app version, not a silent recopy/re-sign. Exactly one process must
map the configured executable; a matching process name is insufficient. The
microsecond-resolution lifetime identity is checked before/after attach and
before resume, reusing REA's existing native identity producer.

For an independent check against this already-running copy, set those two
environment variables in the command's environment and run:

```sh
node experiments/native-inspector/verify.mjs
```

Unlike fixture mode, this never launches or terminates the configured app. It
does not assert that an arbitrary app contains the fixture's visual-effect view.

## Final acceptance: do not confuse installation with connection

Keep the three scopes separate: installed/configured, independent transport
verified, and **the actual agent connected and exercised the requested workflow**.
The verifier structurally reports `active_agent_verified: false` and
`integration_complete: false`, even after a successful runtime capture. Its
regression test prevents an independent client from certifying another client.

After registration, reconnect once if the new tools are absent. In the actual
agent session, not a helper SDK script:

1. Discover both servers' tools and actual schemas.
2. Directly call REA `binary_session`; verify server/version/catalog alignment.
3. Directly call this companion's `capture_native_hierarchy` with `{}`.
4. Use its **new** `capture_id` in `inspect_native_hierarchy`, for example with
   `class_contains: "NSVisualEffectView"` and `limit: 5`.
5. Verify target/probe identity, fresh capture, requested coverage/truncation,
   actual node contents and `resumed_after_detach`. Record what passed and any
   limits. Only then report agent integration complete for that bounded scope.

Tools loaded but target absent means **start the approved target**, not reinstall
MCP or restart the agent again. Tools absent after reconnect means inspect the
client's launch diagnostic, not repeat setup blindly. State exactly which gate
is open and whether owner action is needed. A design-parity investigation and
all optional REA providers are separate from this integration gate.

## Failure, cleanup and coverage boundaries

- Already-stopped targets are rejected without changing their debugger state.
- Collection failure still runs detach/resume. A pending SIGSTOP after detach
  is cleared only after rechecking the same process lifetime, not blindly by PID.
- Capture output is published only after successful detach/resume; the server
  independently rechecks identity and non-stopped state before success.
- Timeout, target exit, identity uncertainty or detach failure is a failure,
  not an empty successful capture. Inspect target/debugger state before retrying;
  the server does not blindly send SIGCONT or kill a target after helper timeout.
  Crash recovery and hard-timeout cleanup are not guaranteed. The loaded local
  probe can remain in target memory after detach; detach is not byte restoration.
- Limits: visible windows, depth 64, 8192 visited nodes, 16 MiB readback; retained
  reads are UUID-only and pages are at most 50 nodes. Truncation and unresolved
  references remain explicit. No text/title values are deliberately collected;
  class names, addresses and geometry can still identify app structure. Treat
  captures as local evidence and review before sharing.
- Non-finite numeric values are `null`, not invented zeroes. Shared layers use
  explicit address references, not duplicated subtrees. No glass view in a
  particular capture does not prove the app never uses native glass.
- This is public AppKit state plus internal view/layer structure, not original
  source recovery, SwiftUI SDF/compositor shape decoding, or pixel-perfect parity.
  Debugger instrumentation can affect timing. Cancellation/forced server death
  and other OS/SDK/architecture combinations remain unverified.

Optional Ghidra smoke (configured provider required; this compiles but does not
execute the fixture):

```sh
xcrun clang -g -O0 experiments/native-inspector/decompile-smoke.c -o experiments/native-inspector/build/decompile-smoke
node scripts/rea.mjs decompile experiments/native-inspector/build/decompile-smoke _rea_smoke_add --provider ghidra --json
```

On Mach-O the symbol has a leading underscore. Expected recovered behavior is
`a + b + 7`; compare actual Evidence, not text equality or fixture execution.
