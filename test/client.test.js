// Unit tests: run against the built dist/ with a fake fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import exedev, { ExeAPIError } from "../dist/index.js";

let requests;
let respond;

beforeEach(() => {
  requests = [];
  respond = () => new Response("{}", { status: 200 });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return respond(url, init);
  };
});

const exe = () => exedev({ token: "exe1.test", baseURL: "https://example.test/" });

test("exec posts the command with a bearer token", async () => {
  respond = () => new Response("hello", { status: 200 });
  const res = await exe().exec("help");
  assert.deepEqual(res, { status: 200, body: "hello", ok: true });
  assert.equal(requests[0].url, "https://example.test/exec");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer exe1.test");
  assert.equal(requests[0].init.body, "help");
});

test("new passes the name as --name and returns vm_name", async () => {
  respond = () =>
    new Response(JSON.stringify({ vm_name: "my-vm", ssh_dest: "my-vm.exe.xyz" }));
  assert.equal(await exe().new("my-vm"), "my-vm");
  assert.equal(requests[0].init.body, "new --name=my-vm");
});

test("new with no name lets exe.dev pick one", async () => {
  respond = () => new Response(JSON.stringify({ vm_name: "auto-name" }));
  assert.equal(await exe().new(), "auto-name");
  assert.equal(requests[0].init.body, "new");
});

test("new passes image and tags", async () => {
  respond = () => new Response(JSON.stringify({ vm_name: "my-vm" }));
  await exe().new("my-vm", { image: "ubuntu:24.04", tags: ["a", "b"] });
  assert.equal(requests[0].init.body, "new --name=my-vm --image=ubuntu:24.04 --tag=a,b");
});

test("new throws ExeAPIError on failure", async () => {
  respond = () => new Response('{"error":"nope"}', { status: 422 });
  await assert.rejects(exe().new("my-vm"), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.status, 422);
    assert.equal(err.command, "new --name=my-vm");
    return true;
  });
});

test("rm resolves when the VM is deleted", async () => {
  respond = () => new Response('{"deleted":["my-vm"],"failed":[]}\n');
  await exe().rm("my-vm");
  assert.equal(requests[0].init.body, "rm my-vm");
});

test("rm throws when the VM is not deleted, despite a 200", async () => {
  // What exe.dev returns for rm of a VM that does not exist.
  respond = () =>
    new Response(
      '{"error":"VM \\"my-vm\\" not found"}\n{"deleted":[],"failed":["my-vm"]}\n',
      { status: 200 },
    );
  await assert.rejects(exe().rm("my-vm"), (err) => {
    assert.ok(err instanceof ExeAPIError);
    assert.equal(err.command, "rm my-vm");
    return true;
  });
});
