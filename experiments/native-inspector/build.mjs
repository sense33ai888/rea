import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = import.meta.dirname;
export const build = join(root, "build");

export async function buildInspector() {
  if (process.platform !== "darwin")
    throw new Error("macOS and Xcode command-line tools are required");
  await mkdir(build, { recursive: true });
  const options = { timeout: 120_000, maxBuffer: 1024 * 1024 };
  await run(
    "/usr/bin/xcrun",
    [
      "clang",
      "-g",
      "-dynamiclib",
      "-fobjc-arc",
      "-fblocks",
      "-Wno-arc-retain-cycles",
      "-framework",
      "Cocoa",
      "-framework",
      "QuartzCore",
      join(root, "native-hierarchy-probe.m"),
      "-o",
      join(build, "native-hierarchy-probe.dylib"),
    ],
    options,
  );
  // Reuse REA's microsecond-resolution process identity producer, not ps display text.
  await run(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-parse-as-library",
      resolve(root, "../../bridge/process/ProcessRunTokenReader.swift"),
      resolve(root, "../../bridge/process/ProcessRunTokenReaderMain.swift"),
      "-o",
      join(build, "process-identity"),
    ],
    options,
  );
  await run(
    "/usr/bin/xcrun",
    [
      "clang",
      "-g",
      "-fobjc-arc",
      "-fblocks",
      "-framework",
      "Cocoa",
      "-framework",
      "QuartzCore",
      join(root, "fixture.m"),
      "-o",
      join(build, "ReaNativeFixture"),
    ],
    options,
  );
  return build;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  console.log(await buildInspector());
}
