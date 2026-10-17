import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { configuration, createInspector, findTarget, flatten } from "./mcp.mjs";
import { transportReport } from "./verify.mjs";

test("independent verifier cannot certify the active agent, even with a passing capture", () => {
  const report = transportReport({
    server: { name: "rea-native-inspector-companion" },
    capture: { nodes: 100, truncated: false, resumed_after_detach: true },
    fixture: false,
    active_agent_verified: true,
    integration_complete: true,
  });
  assert.equal(report.transport_passed, true);
  assert.equal(report.active_agent_verified, false);
  assert.equal(report.integration_complete, false);
  assert.equal(report.client_origin, "independent SDK verifier");
});

test("missing target is actionable; matching name alone never selects an installed app", async () => {
  const config = { executable: "/debug/My App.app/Contents/MacOS/Matrix" };
  await assert.rejects(
    findTarget(config, async () => {
      throw Object.assign(new Error("pgrep"), { code: 1 });
    }),
    /not running.*do not reinstall/,
  );
  const runner = (paths) => async (command, args) => {
    if (command.endsWith("pgrep")) return { stdout: "17\n18\n" };
    assert.equal(command, "/usr/sbin/lsof");
    return { stdout: `p${args[2]}\nn${paths[args[2]]}\n` };
  };
  assert.equal(
    await findTarget(
      config,
      runner({
        17: "/Applications/Matrix.app/Contents/MacOS/Matrix",
        18: config.executable,
      }),
    ),
    18,
  );
  await assert.rejects(
    findTarget(
      config,
      runner({ 17: config.executable, 18: config.executable }),
    ),
    /Exactly one/,
  );
});

test("startup requires explicit identity and rejects changed executable bytes", async () => {
  await assert.rejects(configuration({}), /REA_NATIVE_EXECUTABLE/);
  const dir = await mkdtemp(join(tmpdir(), "rea-native-config-"));
  try {
    const executable = join(dir, "debug fixture");
    await writeFile(executable, "fixture");
    const env = {
      REA_NATIVE_EXECUTABLE: executable,
      REA_NATIVE_EXECUTABLE_SHA256: "0".repeat(64),
    };
    await assert.rejects(configuration(env), /SHA-256 mismatch/);
    env.REA_NATIVE_EXECUTABLE_SHA256 = createHash("sha256")
      .update("fixture")
      .digest("hex");
    assert.equal(
      (await configuration(env)).executable,
      await realpath(executable),
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("deduplicate layer references, retain nonfinite nulls, distinguish truncation", () => {
  const layer = {
    class: "CALayer",
    address: "0x1",
    cornerRadius: null,
    children: [],
  };
  const document = {
    truncated: false,
    windows: [
      { class: "NSView", address: "0x2", children: [], layer },
      { ref: "0x1" },
    ],
  };
  const flat = flatten(document);
  assert.equal(flat.rows.length, 2);
  assert.equal(flat.rows[1].cornerRadius, null);
  assert.deepEqual(flat.unresolved, []);
  document.windows.push({ ref: "0x3" });
  assert.throws(() => flatten(document), /unresolved/);
  assert.deepEqual(flatten({ ...document, truncated: true }).unresolved, [
    "0x3",
  ]);
});

test("actual MCP schema rejects traversal and unbounded pages; retained pages preserve coverage", async () => {
  const captures = await mkdtemp(join(tmpdir(), "rea-native-pages-"));
  const server = createInspector({ captures });
  const client = new Client({ name: "native-regression", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const tools = (await client.listTools()).tools;
    assert.equal(
      tools.find((t) => t.name === "capture_native_hierarchy").annotations
        .readOnlyHint,
      false,
    );
    const id = randomUUID();
    await writeFile(
      join(captures, `${id}.json`),
      JSON.stringify({
        truncated: false,
        windows: [
          {
            class: "NSView",
            address: "0x1",
            children: [
              {
                class: "NSVisualEffectView",
                address: "0x2",
                children: [],
                effect: { material: 21 },
              },
            ],
          },
        ],
      }),
    );
    const call = (args) =>
      client.callTool({ name: "inspect_native_hierarchy", arguments: args });
    const first = (await call({ capture_id: id, limit: 1 })).structuredContent;
    assert.equal(first.next_offset, 1);
    assert.equal(first.truncated, false);
    const next = (
      await call({ capture_id: id, offset: first.next_offset, limit: 1 })
    ).structuredContent;
    assert.equal(next.next_offset, null);
    assert.equal(next.rows[0].class, "NSVisualEffectView");
    assert.equal(next.sha256, first.sha256);
    const filtered = (
      await call({ capture_id: id, class_contains: "NSVisualEffectView" })
    ).structuredContent;
    assert.equal(filtered.total, 1);
    for (const bad of [
      { capture_id: "../../bad" },
      { capture_id: id, limit: 51 },
      { capture_id: id, offset: -1 },
    ]) {
      assert.equal((await call(bad)).isError, true);
    }
  } finally {
    await client.close();
    await server.close();
    await rm(captures, { recursive: true });
  }
});
