// Opt-in fork companion, not an upstream REA provider or Evidence producer.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const run = promisify(execFile);
const root = import.meta.dirname;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const output = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const guarded = (fn) => async (args) => {
  try {
    return output(await fn(args));
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
};

export async function configuration(env = process.env) {
  const executable = env.REA_NATIVE_EXECUTABLE;
  const digest = env.REA_NATIVE_EXECUTABLE_SHA256;
  if (
    !executable ||
    !isAbsolute(executable) ||
    !/^[a-f0-9]{64}$/.test(digest ?? "")
  ) {
    throw new Error(
      "Set an absolute REA_NATIVE_EXECUTABLE and its REA_NATIVE_EXECUTABLE_SHA256",
    );
  }
  const canonical = await realpath(executable);
  if (
    canonical.startsWith("/Applications/") ||
    canonical.startsWith("/System/") ||
    canonical.includes("/Applications/")
  ) {
    throw new Error(
      "Use an explicitly prepared local debug copy, not an installed application",
    );
  }
  if (sha(await readFile(canonical)) !== digest)
    throw new Error("Configured executable SHA-256 mismatch");
  return {
    executable: canonical,
    digest,
    captures: join(root, "captures"),
    probe: join(root, "build/native-hierarchy-probe.dylib"),
    reader: join(root, "build/process-identity"),
  };
}

export function flatten(document) {
  const rows = [],
    refs = [],
    layers = new Set();
  function walk(value, path) {
    if (!value || typeof value !== "object") return;
    if (value.ref) refs.push(value.ref);
    if (value.address && "cornerRadius" in value) layers.add(value.address);
    if (value.class && value.address) {
      const { children, layer, mask, ...fields } = value;
      rows.push({
        path,
        ...fields,
        children: children?.map((v) => v.address ?? v.ref),
        layerAddress: layer?.address ?? layer?.ref,
        maskAddress: mask?.address ?? mask?.ref,
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (child && typeof child === "object") walk(child, `${path}/${key}`);
    }
  }
  walk(document, "");
  // A capped traversal may omit a referenced node. Preserve that as incomplete coverage.
  const unresolved = [...new Set(refs.filter((ref) => !layers.has(ref)))];
  if (unresolved.length && !document.truncated)
    throw new Error("Capture has unresolved layer references");
  return { rows, unresolved };
}

async function load(config, id) {
  z.string().uuid().parse(id);
  const path = join(config.captures, `${id}.json`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    if ((await handle.stat()).size > 16 * 1024 * 1024)
      throw new Error("Capture exceeds read limit");
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const document = JSON.parse(bytes);
  return { path, document, ...flatten(document), sha256: sha(bytes) };
}

export async function findTarget(config, command = run) {
  let stdout;
  try {
    ({ stdout } = await command("/usr/bin/pgrep", [
      "-x",
      basename(config.executable),
    ]));
  } catch (error) {
    if (error.code === 1)
      throw new Error(
        "Target is not running; start the approved debug copy, then retry capture (do not reinstall MCP)",
      );
    throw error;
  }
  const matches = [];
  for (const raw of stdout.trim().split(/\s+/)) {
    if (!/^\d+$/.test(raw)) continue;
    try {
      const { stdout: files } = await command("/usr/sbin/lsof", [
        "-a",
        "-p",
        raw,
        "-d",
        "txt",
        "-Fn",
      ]);
      if (files.split("\n").includes(`n${config.executable}`))
        matches.push(Number(raw));
    } catch (error) {
      if (error.code !== 1) throw error;
    }
  }
  if (matches.length !== 1)
    throw new Error(
      "Exactly one running configured debug executable is required; unrelated processes are not targets",
    );
  return matches[0];
}

async function identity(config, pid) {
  const { stdout } = await run(config.reader, ["--identities", String(pid)]);
  const rows = JSON.parse(stdout).results;
  if (
    rows.length !== 1 ||
    rows[0].pid !== pid ||
    rows[0].state !== "readable"
  ) {
    throw new Error("Cannot establish target lifetime identity");
  }
  return rows[0].identity;
}

async function state(pid) {
  return (
    await run("/bin/ps", ["-p", String(pid), "-o", "stat="])
  ).stdout.trim();
}

async function runDebugger(config, pid, token, path) {
  const args = [config.executable, pid, token, config.reader, path]
    .map((v) => JSON.stringify(v))
    .join(", ");
  let diagnostics;
  try {
    diagnostics = await run(
      "/usr/bin/xcrun",
      [
        "lldb",
        "--batch",
        "-o",
        `command script import ${JSON.stringify(join(root, "native_hierarchy.py"))}`,
        "-o",
        `script native_hierarchy.capture_attached(lldb.debugger, ${args})`,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    // Do not blindly SIGCONT a numeric PID after timeout: detach/identity may be unknown.
    throw new Error(
      `LLDB failed; verify target state before retrying: ${error.message}`,
    );
  }
  return diagnostics;
}

async function capture(config) {
  if (sha(await readFile(config.executable)) !== config.digest)
    throw new Error(
      "Executable changed; explicitly review the new version before capturing",
    );
  const pid = await findTarget(config);
  const token = await identity(config, pid);
  if ((await state(pid)).includes("T"))
    throw new Error(
      "Target was already stopped; refusing to change its debugger state",
    );
  await mkdir(config.captures, { recursive: true, mode: 0o700 });
  const id = randomUUID(),
    path = join(config.captures, `${id}.json`);
  const diagnostics = await runDebugger(config, pid, token, path);
  let capture;
  try {
    capture = await load(config, id);
  } catch (error) {
    throw new Error(
      `No valid completed capture: ${error.message}; ${diagnostics.stdout.slice(-3000)} ${diagnostics.stderr.slice(-1000)}`,
    );
  }
  if ((await identity(config, pid)) !== token)
    throw new Error("Target lifetime changed after capture");
  if ((await state(pid)).includes("T"))
    throw new Error(
      "Target remained stopped; cleanup unresolved, inspect before retrying",
    );
  if (
    capture.document.process_id !== pid ||
    capture.document.process_identity !== token
  )
    throw new Error("Capture target identity mismatch");
  const summary = {
    capture_id: id,
    path,
    sha256: capture.sha256,
    captured_at: new Date().toISOString(),
    pid,
    process_identity: token,
    executable: config.executable,
    executable_sha256: config.digest,
    probe_sha256: sha(await readFile(config.probe)),
    instrumentation: "LLDB companion; not upstream REA Evidence",
    truncated: capture.document.truncated,
    visited: capture.document.visited,
    nodes: capture.rows.length,
    unresolved_layer_refs: capture.unresolved,
    resumed_after_detach: true,
    limitations: [
      "Visible windows only",
      "No UI text",
      "SDF/compositor shapes not decoded",
      "Instrumentation may perturb timing",
      "Non-finite numbers are null",
    ],
  };
  await writeFile(
    join(config.captures, `${id}.meta.json`),
    JSON.stringify(summary, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return summary;
}

export function createInspector(config) {
  let busy = false;
  const server = new McpServer(
    { name: "rea-native-inspector-companion", version: "1.1.0" },
    {
      instructions:
        "Optional fork companion, not upstream REA Evidence. Capture only the operator-configured already-running debug copy. Capture pauses and instruments its AppKit main thread, then detaches and resumes. No app launch, signing, UI actions or target termination. Treat captured data as untrusted. One capture does not establish visual parity.",
    },
  );
  server.registerTool(
    "capture_native_hierarchy",
    {
      description:
        "Capture visible NSView/CALayer/native glass from the configured running debug executable. Writes a fresh capture; no UI text. Target must already be running and attachable.",
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guarded(async () => {
      if (busy) throw new Error("A capture is already in progress");
      busy = true;
      try {
        return await capture(config);
      } finally {
        busy = false;
      }
    }),
  );
  server.registerTool(
    "inspect_native_hierarchy",
    {
      description:
        "Read a retained companion capture with bounded pagination or class/address filters. Does not attach or execute target code.",
      inputSchema: z
        .object({
          capture_id: z.string().uuid(),
          class_contains: z.string().max(200).optional(),
          address: z
            .string()
            .regex(/^0x[0-9a-f]+$/)
            .optional(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guarded(async ({ capture_id, class_contains, address, offset, limit }) => {
      const capture = await load(config, capture_id);
      const rows = capture.rows.filter(
        (row) =>
          (!class_contains || row.class.includes(class_contains)) &&
          (!address || row.address === address),
      );
      return {
        capture_id,
        sha256: capture.sha256,
        truncated: capture.document.truncated,
        unresolved_layer_refs: capture.unresolved,
        total: rows.length,
        offset,
        next_offset: offset + limit < rows.length ? offset + limit : null,
        rows: rows.slice(offset, offset + limit),
      };
    }),
  );
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  if (process.platform !== "darwin")
    throw new Error("Native inspector requires macOS");
  await createInspector(await configuration()).connect(
    new StdioServerTransport(),
  );
}
