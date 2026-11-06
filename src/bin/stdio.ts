#!/usr/bin/env node
/**
 * stdio entry point: `npx -y @heliyos/heliyos-mcp`. stdout carries MCP protocol
 * messages only; diagnostics go to stderr and never include the API key.
 *
 * The server needs Node 20 or newer, but `npx` runs whatever `node` is first
 * on the client's PATH, which with version managers is often an old default.
 * So this file does nothing version-specific itself: it checks the running
 * Node first and, when it is too old, re-executes the server on the newest
 * suitable Node it can find on the machine (nvm, fnm, n, Volta, Homebrew,
 * PATH), passing stdio straight through. Only then does it load the server.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../version.js";
import { candidateNodes, findNewerNode, majorOf, MIN_NODE_MAJOR } from "./nodeRuntime.js";

/** Set on the re-executed child so a still-too-old Node can never loop. */
const REEXEC_FLAG = "HELIYOS_MCP_REEXEC";

function log(message: string): void {
  process.stderr.write(`heliyos-mcp: ${message}\n`);
}

/**
 * Runs the server on another Node executable with this process's stdio and
 * environment, and exits with the child's exit code.
 */
function reexec(nodePath: string, version: string): void {
  log(`Node ${process.versions.node} is too old (needs ${MIN_NODE_MAJOR}+); restarting on Node ${version} at ${nodePath}`);
  const child = spawn(nodePath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, [REEXEC_FLAG]: "1" },
  });
  child.on("error", (err) => {
    log(`could not start ${nodePath}: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
}

async function start(): Promise<void> {
  // `--version` answers without starting a server, so a client setup can warm
  // the npx cache (`npx -y @heliyos/heliyos-mcp --version`) ahead of the first run.
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    process.stdout.write(`${PACKAGE_NAME} ${PACKAGE_VERSION} (node ${process.versions.node})\n`);
    return;
  }
  if (majorOf(process.versions.node) < MIN_NODE_MAJOR) {
    const newer = process.env[REEXEC_FLAG] ? undefined : findNewerNode(candidateNodes());
    if (newer) {
      reexec(newer.path, newer.version);
      return;
    }
    log(
      `Node ${process.versions.node} is too old: this server needs Node ${MIN_NODE_MAJOR} or newer and found no newer Node on this machine. ` +
        "Install Node 20+ (https://nodejs.org) or, with nvm, run `nvm install 20 && nvm alias default 20`, then restart your client."
    );
    process.exit(1);
  }
  // Loaded only once the runtime is known to be new enough: these modules use
  // global fetch and other APIs an old Node would fail on at import time.
  const { main } = await import("./serve.js");
  main();
}

void start();
