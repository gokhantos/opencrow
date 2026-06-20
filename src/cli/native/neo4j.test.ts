import { test, expect } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  probeBolt,
  applyConfPin,
  readActiveListenAddresses,
  confPinsLoopback,
  isAlreadyInitialized,
  NEO4J_BOLT_HOST,
  NEO4J_BOLT_PORT,
} from "./neo4j.ts";

test("Bolt endpoint constants are loopback :7687", () => {
  expect(NEO4J_BOLT_HOST).toBe("127.0.0.1");
  expect(NEO4J_BOLT_PORT).toBe(7687);
});

test("applyConfPin replaces a commented key in place", () => {
  const body = "# comment\n#server.bolt.listen_address=:7687\nfoo=bar\n";
  const res = applyConfPin(body, "server.bolt.listen_address", "127.0.0.1:7687");
  expect(res.changed).toBe(true);
  expect(res.body).toContain("server.bolt.listen_address=127.0.0.1:7687");
  expect(res.body).not.toContain("#server.bolt.listen_address");
});

test("applyConfPin replaces an active key with a different value", () => {
  const body = "server.default_listen_address=0.0.0.0\n";
  const res = applyConfPin(body, "server.default_listen_address", "127.0.0.1");
  expect(res.changed).toBe(true);
  expect(res.body).toBe("server.default_listen_address=127.0.0.1\n");
});

test("applyConfPin is a no-op when the key already has the desired value", () => {
  const body = "server.default_listen_address=127.0.0.1\n";
  const res = applyConfPin(body, "server.default_listen_address", "127.0.0.1");
  expect(res.changed).toBe(false);
  expect(res.body).toBe(body);
});

test("applyConfPin appends the key when absent", () => {
  const body = "foo=bar\n";
  const res = applyConfPin(body, "server.http.listen_address", "127.0.0.1:7474");
  expect(res.changed).toBe(true);
  expect(res.body).toBe("foo=bar\nserver.http.listen_address=127.0.0.1:7474\n");
});

test("applyConfPin appends a newline before the key when body lacks a trailing newline", () => {
  const body = "foo=bar";
  const res = applyConfPin(body, "server.http.listen_address", "127.0.0.1:7474");
  expect(res.body).toBe("foo=bar\nserver.http.listen_address=127.0.0.1:7474\n");
});

test("applyConfPin does not match a different key sharing a prefix", () => {
  const body = "server.bolt.listen_address_extra=:9999\n";
  const res = applyConfPin(body, "server.bolt.listen_address", "127.0.0.1:7687");
  // Original line preserved, new line appended.
  expect(res.body).toContain("server.bolt.listen_address_extra=:9999");
  expect(res.body).toContain("server.bolt.listen_address=127.0.0.1:7687");
});

test("readActiveListenAddresses + confPinsLoopback agree on a fully-pinned conf", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neo4j-conf-"));
  const confPath = path.join(dir, "neo4j.conf");
  fs.writeFileSync(
    confPath,
    [
      "server.default_listen_address=127.0.0.1",
      "server.bolt.listen_address=127.0.0.1:7687",
      "server.http.listen_address=127.0.0.1:7474",
    ].join("\n") + "\n",
  );
  const active = readActiveListenAddresses(confPath);
  expect(active["server.default_listen_address"]).toBe("127.0.0.1");
  expect(active["server.bolt.listen_address"]).toBe("127.0.0.1:7687");
  expect(confPinsLoopback(confPath)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("confPinsLoopback is false when keys are only commented (default)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neo4j-conf-"));
  const confPath = path.join(dir, "neo4j.conf");
  fs.writeFileSync(
    confPath,
    [
      "#server.default_listen_address=0.0.0.0",
      "#server.bolt.listen_address=:7687",
      "#server.http.listen_address=:7474",
    ].join("\n") + "\n",
  );
  expect(confPinsLoopback(confPath)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("confPinsLoopback is false when bound to 0.0.0.0", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neo4j-conf-"));
  const confPath = path.join(dir, "neo4j.conf");
  fs.writeFileSync(
    confPath,
    [
      "server.default_listen_address=0.0.0.0",
      "server.bolt.listen_address=127.0.0.1:7687",
      "server.http.listen_address=127.0.0.1:7474",
    ].join("\n") + "\n",
  );
  expect(confPinsLoopback(confPath)).toBe(false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("confPinsLoopback is false when the conf is missing", () => {
  expect(confPinsLoopback(path.join(os.tmpdir(), "does-not-exist-neo4j.conf"))).toBe(false);
});

test("isAlreadyInitialized recognizes the live-data message but not real errors", () => {
  expect(
    isAlreadyInitialized(
      "command failed: The provided initial password was not set because live data was found",
    ),
  ).toBe(true);
  expect(isAlreadyInitialized("Permission denied")).toBe(false);
  expect(isAlreadyInitialized("Error: Could not find or load main class")).toBe(false);
});

test("probeBolt resolves true when a listener accepts the connection", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no port");
  const ok = await probeBolt("127.0.0.1", addr.port, 1000);
  server.close();
  expect(ok).toBe(true);
});

test("probeBolt resolves false for a closed port within the timeout", async () => {
  // Bind+immediately close to obtain a port nothing is listening on.
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no port");
  const port = addr.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const ok = await probeBolt("127.0.0.1", port, 500);
  expect(ok).toBe(false);
});
