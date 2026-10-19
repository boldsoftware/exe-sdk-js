// Unit tests: run against the built dist/ with a fake fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import exedev, { ExeAPIError, ExeNetworkError } from "../dist/index.js";
import { quote } from "../dist/client.js";

let requests;
let respond;

beforeEach(() => {
  requests = [];
  respond = (_url, init) => {
    const command = init.body;
    if (command.startsWith("new")) return new Response(JSON.stringify({ vm_name: "my-vm", tags: [], ssh_dest: "my-vm.exe.xyz", https_url: "https://my-vm.exe.xyz" }));
    if (command.startsWith("ls")) return new Response('{"vms":[]}');
    if (command.startsWith("cp")) return new Response('{"name":"copy","ssh":"copy.exe.xyz","state":"starting"}');
    if (command.startsWith("rename")) return new Response('{"old_name":"old","new_name":"new"}');
    if (command.startsWith("rm ")) return new Response(JSON.stringify({ deleted: [command.slice(3)], failed: [] }));
    if (command.startsWith("ssh ")) return ndjson([{ exit_code: 0 }]);
    return new Response("{}");
  };
});

const exe = () =>
  exedev({
    token: "exe1.test",
    baseURL: "https://example.test/",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return respond(url, init);
    },
  });

const sent = () => requests.map((r) => r.init.body);

test("client posts the command with a bearer token", async () => {
  respond = () => new Response("hello", { status: 200 });
  const res = await exe().doc("help");
  assert.equal(res, "hello");
  assert.equal(requests[0].url, "https://example.test/exec");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer exe1.test");
  assert.equal(requests[0].init.body, "doc help");
});

test("a token is required", () => {
  assert.throws(() => exedev({ token: "" }), /token is required/);
});

test("new returns a VM with normalized metadata", async () => {
  const vm = await exe().new({ name: "my-vm", waitUntil: "created" });
  assert.equal(vm.name, "my-vm");
  assert.equal(vm.httpsUrl, "https://my-vm.exe.xyz");
  assert.equal(typeof vm.ssh, "function");
  assert.deepEqual(sent(), ["new --name=my-vm"]);
  respond = () => new Response(JSON.stringify({ vm_name: "my-vm", tags: [], ssh_dest: "my-vm.exe.xyz", https_url: "https://my-vm.exe.xyz", comment: "note" }));
  assert.equal((await exe().new({ comment: "note", waitUntil: "created" })).info.comment, "note");
});

test("options become flags, spelled as on the command line", async () => {
  await exe().new({
    waitUntil: "created",
    name: "my-vm",
    image: "ubuntu:24.04",
    tag: ["a", "b"],
    env: "FOO=bar baz",
    "no-email": true,
    sandbox: false,
    cpu: 4,
  });
  assert.deepEqual(sent(), [
    "new --name=my-vm --image=ubuntu:24.04 --tag=a --tag=b --env='FOO=bar baz' --no-email --sandbox=false --cpu=4",
  ]);
});

test("unknown options are rejected before any request", async () => {
  await assert.rejects(exe().new({ nope: 1 }), TypeError);
  assert.deepEqual(sent(), []);
});

test("positionals: optional, variadic, and quoted", async () => {
  const c = exe();
  await c.ls();
  await c.ls("web-*", { l: true });
  await c.vm("b").rm();
  await c.vm("a").rm();
  await c.vm("old").rename("new");
  await c.vm("my-vm").comment("it's a VM");
  await c.vm("src").cp({ waitUntil: "created" });
  await c.vm("my-vm").tag(["a", "b"]);
  assert.deepEqual(sent(), [
    "ls",
    "ls --l 'web-*'",
    "rm b",
    "rm a",
    "rename old new",
    `comment my-vm 'it'"'"'s a VM'`,
    "cp src",
    "tag my-vm a b",
  ]);
});

test("a positional that looks like a flag follows --", async () => {
  await exe().vm("my-vm").comment("-x");
  assert.deepEqual(sent(), ["comment -- my-vm -x"]);
});

test("subcommand paths become camel-cased methods", async () => {
  await exe().sshKeyList();
  await exe().vm("my-vm").shareShow();
  assert.deepEqual(sent(), ["ssh-key list", "share show my-vm"]);
});

test("quote", () => {
  assert.equal(quote("plain-word_1.2/x:y@z,w=v"), "plain-word_1.2/x:y@z,w=v");
  assert.equal(quote(""), "''");
  assert.equal(quote("a b"), "'a b'");
  assert.equal(quote(`"$HOME"`), `'"$HOME"'`);
  assert.equal(quote("it's"), `'it'"'"'s'`);
});

test("failures throw ExeAPIError with the server's reason, not the request", async () => {
  respond = () => new Response('{"error":"VM name is taken"}', { status: 422 });
  await assert.rejects(exe().new({ name: "my-vm", env: "TOKEN=secret-value" }), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.status, 422);
    assert.equal(err.operation, "new");
    assert.equal(err.message, "exe.dev API error (422) during new: VM name is taken");
    return true;
  });
});

test("the server's reason is one line of at most 200 characters", async () => {
  respond = () => new Response(JSON.stringify({ error: `multi\n  line ${"x".repeat(300)}` }), { status: 422 });
  await assert.rejects(exe().vm("my-vm").pause(), (err) => {
    const reason = err.message.slice("exe.dev API error (422) during pause: ".length);
    assert.match(reason, /^multi line x+…$/);
    assert.equal(reason.length, 200);
    return true;
  });
  respond = () => new Response("<html>bad gateway</html>", { status: 502 });
  await assert.rejects(exe().vm("my-vm").pause(), { message: "exe.dev API error (502) during pause" });
});

test("the server's reason carries no terminal escapes or control characters", async () => {
  // As the server sent it for ssh to a stopped VM.
  respond = () => new Response(JSON.stringify({
    error: 'VM "my-vm" is not running.\n\nTo see why it failed, run:\n\n    \u001b[1mvm-logs my-vm\u001b[0m\n',
  }), { status: 422 });
  await assert.rejects(exe().vm("my-vm").pause(), {
    message: 'exe.dev API error (422) during pause: VM "my-vm" is not running. To see why it failed, run: vm-logs my-vm',
  });
  respond = () => new Response(JSON.stringify({
    error: "a\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007 \u001b[2K\rb\u0000\u0007\u009b31m\u202eevil\u202c c",
  }), { status: 422 });
  await assert.rejects(exe().vm("my-vm").pause(), (err) => {
    assert.equal(err.message, "exe.dev API error (422) during pause: alink b31mevil c");
    // The full body stays as sent, for opt-in diagnostics.
    assert.match(err.details().body, /\\u001b/);
    return true;
  });
});

test("a failed request is an ExeNetworkError for every operation, with its cause opt-in", async () => {
  const failure = () => { throw new TypeError("fetch failed: Authorization: Bearer exe1.secret", { cause: Object.assign(new Error("socket"), { code: "UND_ERR_SOCKET" }) }); };
  for (const call of [(c) => c.new({ name: "my-vm" }), (c) => c.ls(), (c) => c.whoami(), (c) => c.vm("my-vm").restart({ waitUntil: "created" })]) {
    respond = failure;
    await assert.rejects(call(exe()), (err) => {
      assert.ok(err instanceof ExeNetworkError, String(err));
      assert.match(err.message, /^exedev: network error during (new|ls|whoami|restart) \(UND_ERR_SOCKET\); whether it took effect is unknown$/);
      assert.match(err.details().cause.message, /exe1\.secret/);
      assert.doesNotMatch(inspect(err), /exe1\.secret/);
      return true;
    });
  }
  // A connection lost while reading the response is the same: the server may have acted.
  respond = () => new Response(new ReadableStream({ pull(c) { c.error(new Error("reset")); } }));
  await assert.rejects(exe().new({ name: "my-vm" }), (err) => err instanceof ExeNetworkError && err.operation === "new" &&
    err.message === "exedev: network error during new; whether it took effect is unknown");
  // The caller's own cancellation is still the caller's reason.
  const abort = new AbortController();
  const reason = new Error("stop");
  respond = () => { abort.abort(reason); throw new DOMException("aborted", "AbortError"); };
  await assert.rejects(exe().ls(undefined, { signal: abort.signal }), (err) => err === reason);
});

test("an error document throws despite a 200", async () => {
  respond = () => new Response('{"error":"no such thing"}\n{"ok":true}\n', { status: 200 });
  await assert.rejects(exe().vm("my-vm").pause(), {
    name: "ExeAPIError", status: 200, message: "exe.dev API error (200) during pause: no such thing",
  });
});

test("vm.rm of a missing VM is a 404 with the server's reason", async () => {
  // exe.dev reports per-VM failures in band, beside a summary, with a 200.
  respond = () => new Response(
    '{"error":"VM \\"my-vm\\" not found"}\n' +
    '{"deleted":[],"failed":["my-vm"],"not_found":["my-vm"],"errors":{"my-vm":"VM \\"my-vm\\" not found"}}\n');
  await assert.rejects(exe().vm("my-vm").rm(), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.operation, "rm");
    assert.equal(err.status, 404);
    assert.equal(err.message, 'exe.dev API error (404) during rm: VM "my-vm" not found');
    return true;
  });
  // Any other failure, or a server without not_found, is a failed command.
  respond = () => new Response(
    '{"error":"VM \\"my-vm\\" is locked: \\"billing\\""}\n{"deleted":[],"failed":["my-vm"]}\n');
  await assert.rejects(exe().vm("my-vm").rm(), { status: 422, message: /during rm: VM "my-vm" is locked/ });
  respond = () => new Response('{"deleted":["my-vm"],"failed":[]}');
  assert.deepEqual(await exe().vm("my-vm").rm(), { deleted: ["my-vm"], failed: [] });
  respond = () => new Response('{"deleted":"my-vm"}');
  await assert.rejects(exe().vm("my-vm").rm(), { name: "ExeProtocolError" });
});

test("exe.rm deletes many VMs in one request and reports each outcome", async () => {
  const c = exe();
  respond = () => new Response(
    '{"error":"VM \\"gone\\" not found"}\n' +
    '{"deleted":["a","b"],"failed":["gone"],"not_found":["gone"],"errors":{"gone":"VM \\"gone\\" not found"}}\n');
  const result = await c.rm(["a", c.vm("b"), "gone", "a"]);
  assert.deepEqual(result, { deleted: ["a", "b"], failed: ["gone"], not_found: ["gone"], errors: { gone: 'VM "gone" not found' } });
  assert.deepEqual(sent(), ["rm a b gone"]);
  assert.deepEqual(await c.rm([]), { deleted: [], failed: [], not_found: [], errors: {} });
  assert.equal(sent().length, 1, "nothing to delete needs no request");
  await assert.rejects(c.rm(["a; reboot"]), TypeError);
  await assert.rejects(c.rm("abc"), TypeError, "a string is not a list of VMs a, b, and c");
  assert.equal(sent().length, 1);
  respond = () => new Response('{"error":"command not allowed by token permissions"}', { status: 403 });
  await assert.rejects(c.rm(["a"]), { name: "ExeAPIError", status: 403 });
});

test("a result with an error field alongside others is not a failure", async () => {
  respond = () => new Response('{"vm_name":"my-vm","ssh_dest":"my-vm.exe.xyz","https_url":"https://my-vm.exe.xyz","error":"shelley setup failed"}');
  assert.equal((await exe().new({ waitUntil: "created" })).info.promptError, "shelley setup failed");
});

test("non-JSON output is returned as text", async () => {
  respond = () => new Response("Usage: team vm ls\n");
  assert.equal(await exe().teamMembers(), "Usage: team vm ls\n");
});

// An NDJSON ssh body, as exe.dev sends it for Accept: application/x-ndjson.
const ndjson = (lines, init) =>
  new Response(lines.map((l) => JSON.stringify(l) + "\n").join(""), {
    headers: { "Content-Type": "application/x-ndjson" },
    ...init,
  });
const b64 = (s) => Buffer.from(s, "latin1").toString("base64");


test("ssh returns stdout and stderr, byte for byte, and the exit code", async () => {
  const bin = "\x00\xff\xfe\x1b[31m\r\n";
  respond = () =>
    ndjson([
      { stdout: b64("hi ") },
      { stderr: b64("warning\n") },
      { stdout: b64(bin) },
      { stderr: b64("done\n") },
      { exit_code: 0 },
    ]);
  const res = await exe().vm("my-vm").ssh("echo hi; cat x.bin");
  assert.deepEqual(sent(), [`ssh my-vm 'echo hi; cat x.bin'`]);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.stdoutBytes, new Uint8Array(Buffer.from("hi " + bin, "latin1")));
  assert.equal(res.stdout, "hi \x00\ufffd\ufffd\x1b[31m\r\n");
  assert.deepEqual(res.stderrBytes, new TextEncoder().encode("warning\ndone\n"));
  assert.equal(res.stderr, "warning\ndone\n");
});

test("ssh reports a failed command as its exit code, not an error", async () => {
  respond = () => ndjson([{ stderr: b64("nope\n") }, { exit_code: 7 }]);
  const res = await exe().vm("my-vm").ssh("exit 7");
  assert.equal(res.exitCode, 7);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "nope\n");
});

test("ssh reads frames split across chunks", async () => {
  const body = [{ stdout: b64("one\n") }, { stdout: b64("two\n") }, { exit_code: 1 }]
    .map((l) => JSON.stringify(l) + "\n")
    .join("");
  const bytes = new TextEncoder().encode(body);
  respond = () =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += 5) c.enqueue(bytes.slice(i, i + 5));
          c.close();
        },
      }),
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
  const res = await exe().vm("my-vm").ssh("x");
  assert.equal(res.stdout, "one\ntwo\n");
  assert.equal(res.exitCode, 1);
});

test("ssh rejects output that ends before the exit code", async () => {
  respond = () => ndjson([{ stdout: b64("partial") }]);
  await assert.rejects(exe().vm("my-vm").ssh("cat big"), /before the command's exit status arrived/);
});

test("ssh rejects with the error that ends a stream in place of the exit code", async () => {
  const error = "the VM did not report the command's exit status; its output may be incomplete";
  respond = () => ndjson([{ stdout: b64("partial") }, { error }]);
  await assert.rejects(exe().vm("my-vm").ssh("cat big"), (err) => {
    assert.ok(!(err instanceof ExeAPIError), "the command ran; ExeAPIError means it did not");
    assert.equal(err.details().message, error);
    assert.equal(err.stdout, "partial");
    return true;
  });
});

// A response whose NDJSON lines the test writes as it goes.
const liveNDJSON = (source = {}) => {
  const enc = (o) => new TextEncoder().encode(JSON.stringify(o) + "\n");
  let controller;
  const res = new Response(
    new ReadableStream({
      start(c) {
        controller = c;
      },
      ...source,
    }),
    { headers: { "Content-Type": "application/x-ndjson" } },
  );
  return { res, send: (o) => controller.enqueue(enc(o)), close: () => controller.close() };
};

test("ssh calls onStdout as output arrives, before the command exits", { timeout: 5000 }, async () => {
  const live = liveNDJSON();
  respond = () => live.res;
  let first;
  const got = new Promise((r) => (first = r));
  const run = exe().vm("my-vm").ssh("tail -f log", { onStdout: first });
  live.send({ stdout: b64("first\n") });
  assert.equal(await got, "first\n");
  live.send({ exit_code: 0 });
  live.close();
  assert.equal((await run).stdout, "first\n");
});

test("ssh calls onStdout and onStderr in the order output arrives, one at a time", async () => {
  respond = () =>
    ndjson([{ stdout: b64("a") }, { stderr: b64("b") }, { stdout: b64("c") }, { stderr: b64("d") }, { exit_code: 2 }]);
  const events = [];
  const res = await exe().vm("my-vm").ssh("x", {
    // Async callbacks are awaited: "err b" waits for "end a".
    onStdout: async (s) => {
      events.push(`start ${s}`);
      await null;
      events.push(`end ${s}`);
    },
    onStderr: (s) => events.push(`err ${s}`),
  });
  assert.deepEqual(events, ["start a", "end a", "err b", "start c", "end c", "err d"]);
  assert.equal(res.exitCode, 2);
  assert.equal(res.stdout, "ac");
  assert.equal(res.stderr, "bd");
});

test("ssh decodes callback text across chunks that split a character", async () => {
  respond = () =>
    ndjson([{ stdout: b64("\xc3") }, { stdout: b64("\xa9!") }, { stderr: b64("\xe2") }, { exit_code: 0 }]);
  const out = [];
  const err = [];
  await exe().vm("my-vm").ssh("x", { onStdout: (s) => out.push(s), onStderr: (s) => err.push(s) });
  assert.deepEqual(out, ["é!"]);
  assert.deepEqual(err, ["\ufffd"]);
});

test("ssh rejects with a callback's error, and stops reading", { timeout: 5000 }, async () => {
  let cancelled = false;
  const live = liveNDJSON({ cancel: () => (cancelled = true) });
  respond = () => live.res;
  const boom = new Error("boom");
  const run = exe().vm("my-vm").ssh("x", {
    onStdout() {
      throw boom;
    },
  });
  live.send({ stdout: b64("x") });
  await assert.rejects(run, (err) => err === boom);
  assert.ok(cancelled, "the response was not cancelled, so the command would keep running");
});

test("ssh throws ExeAPIError for an API rejection", async () => {
  respond = () => new Response('{"error":"VM \\"my-vm\\" not found"}\n', { status: 422 });
  await assert.rejects(exe().vm("my-vm").ssh("true"), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.status, 422);
    assert.equal(err.operation, "ssh");
    assert.match(err.details().body, /not found/);
    return true;
  });
});

test("ssh rejects a stream that breaks off", async () => {
  respond = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ stdout: b64("part") }) + "\n"));
          c.error(new TypeError("terminated"));
        },
      }),
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
  await assert.rejects(exe().vm("my-vm").ssh("cat big"), (err) => {
    assert.match(err.message, /before the command's exit status arrived/);
    assert.equal(err.name, "SSHStreamError");
    assert.equal(err.code, "interrupted");
    return true;
  });
});
