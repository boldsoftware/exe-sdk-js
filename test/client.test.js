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
