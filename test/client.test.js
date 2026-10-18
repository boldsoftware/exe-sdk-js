// Unit tests: run against the built dist/ with a fake fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import exedev, { ExeAPIError } from "../dist/index.js";
import { quote } from "../dist/client.js";

let requests;
let respond;

beforeEach(() => {
  requests = [];
  respond = () => new Response("{}", { status: 200 });
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

test("exec posts the command with a bearer token", async () => {
  respond = () => new Response("hello", { status: 200 });
  const res = await exe().exec("help");
  assert.deepEqual(res, { status: 200, body: "hello", ok: true });
  assert.equal(requests[0].url, "https://example.test/exec");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer exe1.test");
  assert.equal(requests[0].init.body, "help");
});

test("a token is required", () => {
  assert.throws(() => exedev({ token: "" }), /token is required/);
});

test("command methods return the parsed JSON", async () => {
  respond = () => new Response(JSON.stringify({ vm_name: "my-vm", tags: [] }));
  assert.deepEqual(await exe().new({ name: "my-vm" }), { vm_name: "my-vm", tags: [] });
  assert.deepEqual(sent(), ["new --name=my-vm"]);
});

test("options become flags, spelled as on the command line", async () => {
  await exe().new({
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
  await c.rm(["a", "b"]);
  await c.rm("a");
  await c.rename("old", "new");
  await c.comment("my-vm", "it's a VM");
  await c.cp("src");
  assert.deepEqual(sent(), [
    "ls",
    "ls --l 'web-*'",
    "rm a b",
    "rm a",
    "rename old new",
    `comment my-vm 'it'"'"'s a VM'`,
    "cp src",
  ]);
});

test("a positional that looks like a flag follows --", async () => {
  await exe().comment("my-vm", "-x");
  assert.deepEqual(sent(), ["comment -- my-vm -x"]);
});

test("subcommand paths become camel-cased methods", async () => {
  await exe().sshKeyList();
  await exe().shareShow("my-vm");
  assert.deepEqual(sent(), ["ssh-key list", "share show my-vm"]);
});

test("quote", () => {
  assert.equal(quote("plain-word_1.2/x:y@z,w=v"), "plain-word_1.2/x:y@z,w=v");
  assert.equal(quote(""), "''");
  assert.equal(quote("a b"), "'a b'");
  assert.equal(quote(`"$HOME"`), `'"$HOME"'`);
  assert.equal(quote("it's"), `'it'"'"'s'`);
});

test("failures throw ExeAPIError with the server's message", async () => {
  respond = () => new Response('{"error":"nope"}', { status: 422 });
  await assert.rejects(exe().new({ name: "my-vm" }), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.status, 422);
    assert.equal(err.command, "new --name=my-vm");
    assert.equal(err.message, "exe.dev API error (422): nope");
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
  await assert.rejects(exe().rm("my-vm"), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.command, "rm my-vm");
    assert.equal(err.message, 'exe.dev API error (200): VM "my-vm" not found');
    return true;
  });
});

test("a result with an error field alongside others is not a failure", async () => {
  respond = () => new Response('{"vm_name":"my-vm","error":"shelley setup failed"}');
  assert.equal((await exe().new()).vm_name, "my-vm");
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

test("exec asks for NDJSON, which carries ssh's exit code", async () => {
  respond = () => ndjson([{ stdout: b64("hello\n") }, { stderr: b64("oops\n") }, { exit_code: 3 }]);
  const res = await exe().exec("ssh my-vm false");
  assert.deepEqual(res, { status: 200, body: "hello\noops\n", ok: false, exitCode: 3 });
  assert.match(requests[0].init.headers.Accept, /application\/x-ndjson/);
});

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
  const res = await exe().ssh("my-vm", "echo hi; cat x.bin");
  assert.deepEqual(sent(), [`ssh my-vm 'echo hi; cat x.bin'`]);
  assert.equal(res.exitCode, 0);
  assert.deepEqual(res.stdoutBytes, new Uint8Array(Buffer.from("hi " + bin, "latin1")));
  assert.equal(res.stdout, "hi \x00\ufffd\ufffd\x1b[31m\r\n");
  assert.deepEqual(res.stderrBytes, new TextEncoder().encode("warning\ndone\n"));
  assert.equal(res.stderr, "warning\ndone\n");
});

test("ssh reports a failed command as its exit code, not an error", async () => {
  respond = () => ndjson([{ stderr: b64("nope\n") }, { exit_code: 7 }]);
  const res = await exe().ssh("my-vm", "exit 7");
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
  const res = await exe().ssh("my-vm", "x");
  assert.equal(res.stdout, "one\ntwo\n");
  assert.equal(res.exitCode, 1);
});

test("ssh rejects output that ends before the exit code", async () => {
  respond = () => ndjson([{ stdout: b64("partial") }]);
  await assert.rejects(exe().ssh("my-vm", "cat big"), /before the command exited/);
});

test("ssh rejects with the error that ends a stream in place of the exit code", async () => {
  const error = "the VM did not report the command's exit status; its output may be incomplete";
  respond = () => ndjson([{ stdout: b64("partial") }, { error }]);
  await assert.rejects(exe().ssh("my-vm", "cat big"), (err) => {
    assert.ok(!(err instanceof ExeAPIError), "the command ran; ExeAPIError means it did not");
    assert.equal(err.message, `exedev: ssh my-vm 'cat big': ${error}`);
    return true;
  });
  await assert.rejects(exe().exec("ssh my-vm 'cat big'"), { message: new RegExp(error) });
});

test("ssh throws ExeAPIError when the command never ran", async () => {
  respond = () => new Response('{"error":"VM \\"my-vm\\" not found"}\n', { status: 422 });
  await assert.rejects(exe().ssh("my-vm", "true"), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.status, 422);
    assert.equal(err.command, "ssh my-vm true");
    assert.equal(err.message, 'exe.dev API error (422): VM "my-vm" not found');
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
  await assert.rejects(exe().ssh("my-vm", "cat big"), (err) => {
    assert.match(err.message, /before the command exited/);
    assert.equal(err.cause.message, "terminated");
    return true;
  });
});
