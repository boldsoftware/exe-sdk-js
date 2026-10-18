// Unit tests: run against the built dist/ with a fake fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import exedev, { ExeAPIError } from "../dist/index.js";
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

test("failures throw ExeAPIError without exposing command arguments", async () => {
  respond = () => new Response('{"error":"nope"}', { status: 422 });
  await assert.rejects(exe().new({ name: "my-vm" }), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.status, 422);
    assert.equal(err.operation, "new");
    assert.equal(err.message, "exe.dev API error (422) during new");
    return true;
  });
});

test("an error document throws despite a 200", async () => {
  // What exe.dev returns for rm of a VM that does not exist.
  respond = () =>
    new Response(
      '{"error":"VM \\"my-vm\\" not found"}\n{"deleted":[],"failed":["my-vm"]}\n',
      { status: 200 },
    );
  await assert.rejects(exe().vm("my-vm").rm(), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.operation, "rm");
    assert.match(err.details().body, /not found/);
    return true;
  });
});

test("a result with an error field alongside others is not a failure", async () => {
  respond = () => new Response('{"vm_name":"my-vm","ssh_dest":"my-vm.exe.xyz","https_url":"https://my-vm.exe.xyz","error":"shelley setup failed"}');
  assert.equal((await exe().new({ waitUntil: "created" })).info.setupError, "shelley setup failed");
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
  await assert.rejects(exe().vm("my-vm").ssh("cat big"), /before the command exited/);
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
    assert.match(err.message, /before the command exited/);
    assert.equal(err.name, "SSHStreamError");
    assert.equal(err.code, "interrupted");
    return true;
  });
});
