import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import exedev from "../dist/index.js";

const frame = (value) => new TextEncoder().encode(JSON.stringify(value) + "\n");
const out = (text) => ({ stdout: Buffer.from(text).toString("base64") });
const response = (...values) => new Response(values.map((v) => JSON.stringify(v)).join("\n"), {
  headers: { "Content-Type": "application/x-ndjson" },
});
const client = (fetch) => exedev({ token: "secret-token", fetch });
const ssh = (c, command, options) => c.vm("vm").ssh(command, options);

test("stream-only SSH does not retain output", async () => {
  const chunks = [];
  const result = await ssh(client(async () => response(out("hello"), { exit_code: 0 })), "x", {
    capture: false,
    onStdout: (s) => chunks.push(s),
  });
  assert.deepEqual(chunks, ["hello"]);
  assert.equal(result.captured, false);
  assert.equal(result.stdout, "");
  assert.equal(result.stdoutBytes.length, 0);
});

test("capture limit bounds both output streams and cancels reading", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(frame(out("123")));
      c.enqueue(frame({ stderr: Buffer.from("456").toString("base64") }));
    },
    cancel() { cancelled = true; },
  });
  const c = client(async () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }));
  await assert.rejects(ssh(c, "x", { maxOutputBytes: 4 }), (err) => {
    assert.equal(err.name, "SSHStreamError");
    assert.equal(err.code, "output_limit");
    assert.equal(err.stdout, "123");
    assert.equal(err.stderr, "");
    return true;
  });
  assert.ok(cancelled);
});

test("cancellation preserves the caller's reason during a response", async () => {
  const abort = new AbortController();
  const reason = new DOMException("stop", "AbortError");
  const c = client(async () => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(frame(out("hello")));
      abort.signal.addEventListener("abort", () => stream.error(reason));
    },
  }), { headers: { "Content-Type": "application/x-ndjson" } }));
  await assert.rejects(ssh(c, "x", {
    signal: abort.signal,
    onStdout: () => abort.abort(reason),
  }), (err) => err === reason);
});

test("cancellation before headers also preserves arbitrary signal reasons", async () => {
  const abort = new AbortController();
  const reason = "caller reason";
  const c = client(async () => {
    abort.abort(reason);
    // Some fetch implementations reject with their own error for non-Error reasons.
    throw new TypeError("fetch aborted");
  });
  await assert.rejects(c.whoami({ signal: abort.signal }), (err) => err === reason);
});

test("interrupted streams expose partial output without exposing the command", async () => {
  const c = client(async () => response(out("partial")));
  await assert.rejects(ssh(c, "echo very-sensitive-command"), (err) => {
    assert.equal(err.name, "SSHStreamError");
    assert.equal(err.stdout, "partial");
    assert.doesNotMatch(inspect(err), /very-sensitive-command|secret-token/);
    return true;
  });
});

test("API errors carry the server's reason but keep the request and the full body opt-in", async () => {
  const c = client(async () => new Response('{"error":"VM is not running","trace":"very-sensitive-trace"}\n', { status: 422 }));
  await assert.rejects(ssh(c, "echo very-sensitive-command"), (err) => {
    assert.equal(err.name, "ExeAPIError");
    assert.equal(err.operation, "ssh");
    assert.match(err.message, /: VM is not running$/);
    assert.doesNotMatch(inspect(err), /very-sensitive-command|very-sensitive-trace|secret-token/);
    assert.doesNotMatch(JSON.stringify(err), /very-sensitive-command|very-sensitive-trace|secret-token/);
    assert.match(err.details().body, /very-sensitive-trace/);
    return true;
  });
});

test("typed JSON methods reject malformed, empty and textual responses", async () => {
  for (const body of ['{"vms":', "", "help text"]) {
    await assert.rejects(client(async () => new Response(body)).ls(), { name: "ExeProtocolError" });
  }
});

test("incompatible successful SSH streams are cancelled without consuming their body", async () => {
  let cancelled = false;
  const c = client(async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/octet-stream" } }));
  await assert.rejects(ssh(c, "yes"), { name: "ExeProtocolError", operation: "ssh" });
  assert.ok(cancelled);
});

test("capture has a finite default limit; stream-only mode exceeds it safely", async () => {
  const text = "x".repeat(64 * 1024);
  const values = [...Array(129)].map(() => out(text));
  const c = client(async () => response(...values, { exit_code: 0 }));
  await assert.rejects(ssh(c, "x"), (err) => {
    assert.equal(err.code, "output_limit");
    assert.equal(err.stdoutBytes.length, 8 * 1024 * 1024);
    return true;
  });
  let bytes = 0;
  const result = await ssh(c, "x", { capture: false, onStdout: (s) => { bytes += s.length; } });
  assert.equal(bytes, 129 * text.length);
  assert.equal(result.stdoutBytes.length, 0);
});

test("cancellation interrupts a blocked callback and cancels its response", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const reason = new Error("stop");
  const c = client(async () => new Response(new ReadableStream({
    start(c) { c.enqueue(frame(out("hi"))); },
    cancel() { cancelled = true; },
  }), { headers: { "Content-Type": "application/x-ndjson" } }));
  await assert.rejects(ssh(c, "x", {
    signal: abort.signal,
    onStdout() {
      abort.abort(reason);
      return new Promise(() => {});
    },
  }), (err) => err === reason);
  assert.equal(cancelled, true);
});

test("malformed frames cannot leak output or silently report success", async () => {
  for (const body of [
    '{"stdout":"sensitive-frame",',
    '{"stdout":"!!!!"}',
    '{"unknown":"sensitive-frame"}',
    '{"exit_code":-1}',
    '{"exit_code":0}\n{"stdout":"YQ=="}',
    '{"exit_code":0}\n{"exit_code":1}',
    "x".repeat(1024 * 1024 + 1),
  ]) {
    const c = client(async () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } }));
    await assert.rejects(ssh(c, "sensitive-command"), (err) => {
      assert.equal(err.name, "SSHStreamError");
      assert.equal(err.code, "protocol");
      assert.doesNotMatch(inspect(err), /sensitive-frame|sensitive-command/);
      return true;
    });
  }
});

test("transport errors during streaming preserve partial output without logging their raw message", async () => {
  let reads = 0;
  const c = client(async () => new Response(new ReadableStream({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(frame(out("partial")));
      else controller.error(new Error("request had a sensitive-command"));
    },
  }), { headers: { "Content-Type": "application/x-ndjson" } }));
  await assert.rejects(ssh(c, "sensitive-command"), (err) => {
    assert.equal(err.stdout, "partial");
    assert.equal(err.code, "interrupted");
    assert.doesNotMatch(inspect(err), /sensitive-command/);
    return true;
  });
});
