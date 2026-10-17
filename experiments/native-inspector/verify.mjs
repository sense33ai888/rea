// Independent real-MCP acceptance is deliberately NOT active-agent acceptance.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { build, buildInspector } from "./build.mjs";

const run = promisify(execFile);
const root = import.meta.dirname;

export function transportReport({ server, capture, fixture }) {
  return {
    transport_passed: true,
    runtime_capture_passed: true,
    client_origin: "independent SDK verifier",
    active_agent_verified: false,
    integration_complete: false,
    next_step:
      "Current agent must directly call REA binary_session and both companion tools after connection; this script cannot prove that connection",
    fixture,
    server,
    capture,
    invalid_id_rejected: true,
  };
}

async function verifyCapture(client, fixtureMode) {
  assert.equal(
    client.getServerVersion().name,
    "rea-native-inspector-companion",
  );
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "capture_native_hierarchy",
    "inspect_native_hierarchy",
  ]);
  assert.equal(
    tools.find((t) => t.name === "capture_native_hierarchy").annotations
      .readOnlyHint,
    false,
  );
  const result = await client.callTool(
    { name: "capture_native_hierarchy", arguments: {} },
    { timeout: 90_000 },
  );
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const data = result.structuredContent;
  assert.equal(data.truncated, false);
  assert(data.nodes > 0);
  assert.equal(data.resumed_after_detach, true);
  const page = await client.callTool({
    name: "inspect_native_hierarchy",
    arguments: {
      capture_id: data.capture_id,
      class_contains: "NSVisualEffectView",
      limit: 5,
    },
  });
  assert.notEqual(page.isError, true);
  if (fixtureMode) {
    const effect = page.structuredContent.rows.find(
      (v) => v.frame === "{{8, 8}, {280, 440}}",
    );
    assert(effect, "Known fixture effect is missing");
    assert.deepEqual(effect.effect, {
      material: 21,
      blendingMode: 0,
      state: 1,
    });
    const layer = await client.callTool({
      name: "inspect_native_hierarchy",
      arguments: {
        capture_id: data.capture_id,
        address: effect.layerAddress,
      },
    });
    assert.equal(layer.structuredContent.rows[0].cornerRadius, 17);
    assert.equal(layer.structuredContent.rows[0].masksToBounds, true);
  }
  const bad = await client.callTool({
    name: "inspect_native_hierarchy",
    arguments: { capture_id: "../../bad" },
  });
  assert.equal(bad.isError, true);
  const state = (
    await run("/bin/ps", ["-p", String(data.pid), "-o", "stat="])
  ).stdout.trim();
  assert(!state.includes("T"), "Target remained stopped");
  return data;
}

async function verify() {
  const fixtureMode = process.argv.includes("--fixture");
  const env = { ...process.env };
  let fixture, exited;
  const client = new Client({
    name: "native-independent-verifier",
    version: "1.0.0",
  });
  let transport;
  try {
    if (fixtureMode) {
      await buildInspector();
      env.REA_NATIVE_EXECUTABLE = join(build, "ReaNativeFixture");
      env.REA_NATIVE_EXECUTABLE_SHA256 = createHash("sha256")
        .update(await readFile(env.REA_NATIVE_EXECUTABLE))
        .digest("hex");
      fixture = spawn(env.REA_NATIVE_EXECUTABLE, [], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      exited = new Promise((accept) => {
        fixture.once("exit", accept);
        fixture.once("error", accept);
      });
      await new Promise((accept, reject) => {
        let output = "";
        const timeout = setTimeout(
          () => reject(new Error("Fixture did not become ready")),
          15_000,
        );
        const finish = (fn) => (value) => {
          clearTimeout(timeout);
          fn(value);
        };
        fixture.once("error", finish(reject));
        fixture.once(
          "exit",
          finish(() => reject(new Error("Fixture exited before readiness"))),
        );
        fixture.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("REA_NATIVE_FIXTURE_READY")) finish(accept)();
        });
      });
    }
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "mcp.mjs")],
      env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`${error.message}; ${stderr}`);
    }
    const data = await verifyCapture(client, fixtureMode);
    const report = transportReport({
      fixture: fixtureMode,
      server: client.getServerVersion(),
      capture: data,
    });
    await writeFile(
      join(root, "acceptance-transport.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
    await transport?.close();
    if (fixture) {
      if (fixture.exitCode === null && fixture.signalCode === null)
        fixture.kill("SIGTERM");
      await exited;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  await verify();
