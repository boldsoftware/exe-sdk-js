import { test } from "node:test";
import assert from "node:assert/strict";
import exedev, { VM, VMReadyError, ExeAPIError } from "../dist/index.js";

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const info = (name = "worker") => ({
  vm_name: name, ssh_dest: `${name}.exe.xyz`, https_url: `https://${name}.exe.xyz`,
  tags: ["test"], status: "running", comment: "hello",
});
const exited = (code = 0) => new Response(`{"exit_code":${code}}\n`, {
  headers: { "Content-Type": "application/x-ndjson" },
});
function fixture(respond) {
  const commands = [];
  const exe = exedev({
    token: "test",
    fetch: async (_url, init) => {
      commands.push(init.body);
      return respond(init.body, init);
    },
  });
  return { exe, commands };
}

// Advance only timers actually scheduled by the SDK. No sleeps or wall-clock
// races: fire() waits for a requested backoff/deadline to have been installed.
function clock(t) {
  const timers = new Set();
  const waiting = new Map();
  t.mock.method(globalThis, "setTimeout", (fn, ms) => {
    const timer = { fn, ms };
    timers.add(timer);
    waiting.get(ms)?.(timer);
    waiting.delete(ms);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => timers.delete(timer));
  return {
    timers,
    scheduled(ms) {
      return [...timers].find((timer) => timer.ms === ms) ??
        new Promise((resolve) => waiting.set(ms, resolve));
    },
    async fire(ms) {
      const timer = await this.scheduled(ms);
      timers.delete(timer);
      timer.fn();
    },
  };
}

test("new waits for SSH, retrying only probes; user commands run once", async (t) => {
  const time = clock(t);
  let probes = 0;
  const { exe, commands } = fixture((command) => {
    if (command.startsWith("new")) return json(info());
    if (command === "ssh worker true" && ++probes < 3) {
      return json({ error: "failed to connect to VM: connection refused" }, 422);
    }
    return exited();
  });
  let settled = false;
  const creating = exe.new({ name: "worker" }).then((vm) => { settled = true; return vm; });
  await time.fire(100);
  assert.equal(settled, false);
  await time.fire(200);
  const vm = await creating;
  assert.ok(vm instanceof VM);
  assert.equal(vm.name, "worker");
  assert.equal(vm.httpsUrl, "https://worker.exe.xyz");
  await vm.ssh("echo hello");
  assert.deepEqual(commands, ["new --name=worker", "ssh worker true", "ssh worker true", "ssh worker true", "ssh worker 'echo hello'"]);
  assert.equal(time.timers.size, 0);
});

test("creation can opt out without needing ssh permission", async () => {
  const { exe, commands } = fixture(() => json(info()));
  assert.equal((await exe.new({ waitUntil: "created" })).name, "worker");
  assert.deepEqual(commands, ["new"]);
});

test("cp returns a new ready VM without copying the source's destinations", async () => {
  const { exe, commands } = fixture((command) => command.startsWith("cp") ?
    json({ name: "copy", ssh: "copy.exe.xyz", state: "starting" }) : exited());
  const source = exe.vm("source");
  const copy = await source.cp({ name: "copy", cpu: 4 });
  assert.ok(copy instanceof VM);
  assert.equal(copy.name, "copy");
  assert.equal(copy.sshDest, "copy.exe.xyz");
  assert.equal(copy.httpsUrl, undefined);
  assert.equal(source.name, "source");
  assert.deepEqual(commands, ["cp --cpu=4 source copy", "ssh copy true"]);
});

test("ls, vm and refresh return the same VM API; metadata is a read-only snapshot", async () => {
  const { exe, commands } = fixture(() => json({ vms: [info()] }));
  const [listed] = await exe.ls();
  assert.ok(listed instanceof VM);
  assert.equal(listed.info.comment, "hello");
  const reference = exe.vm("worker");
  assert.equal(reference.httpsUrl, undefined);
  assert.equal(await reference.refresh(), reference);
  assert.equal(reference.httpsUrl, listed.httpsUrl);
  assert.deepEqual(commands, ["ls", "ls worker"]);
  assert.throws(() => { reference.info.name = "other"; }, TypeError);
  assert.throws(() => { reference.tags.push("other"); }, TypeError);
  assert.throws(() => exe.vm("-lroot"), TypeError);
});

test("rename updates the reference only on success and invalidates old URLs", async () => {
  const { exe, commands } = fixture((command) => {
    if (command === "ls") return json({ vms: [info()] });
    if (command === "rename worker renamed") return json({ old_name: "worker", new_name: "renamed" });
    if (command.startsWith("rename")) return json({ error: "taken" }, 422);
    return exited();
  });
  const [vm] = await exe.ls();
  await assert.rejects(vm.rename("taken"), ExeAPIError);
  assert.equal(vm.name, "worker");
  assert.equal(await vm.rename("renamed"), vm);
  assert.equal(vm.name, "renamed");
  assert.equal(vm.httpsUrl, undefined);
  assert.equal(vm.sshDest, undefined);
  await vm.rename("renamed"); // Server's same-name case returns text; don't send it.
  await vm.ssh("true");
  assert.deepEqual(commands, ["ls", "rename worker taken", "rename worker renamed", "ssh renamed true"]);
});

test("restart and resume also wait by default, with an opt-out", async () => {
  const { exe, commands } = fixture((command) => command.startsWith("ssh") ? exited() : json({}));
  const vm = exe.vm("worker");
  assert.equal(await vm.restart(), vm);
  assert.equal(await vm.resume(), vm);
  await vm.restart({ waitUntil: "created" });
  assert.deepEqual(commands, ["restart worker", "ssh worker true", "resume worker", "ssh worker true", "restart worker"]);
});

test("VM operations and raw transport are not a parallel client API", () => {
  const { exe } = fixture(() => json({}));
  for (const name of ["ssh", "cp", "rm", "pause", "resume", "restart", "rename", "resize", "stat", "shareShow", "exec", "run"]) {
    assert.equal(exe[name], undefined, name);
  }
  assert.equal(typeof exe.whoami, "function");
  assert.equal(exe.vm("worker").exec, undefined);
});

test("readiness permission errors fail fast and preserve the created VM for cleanup", async (t) => {
  const time = clock(t);
  const { exe, commands } = fixture((command) => command === "new" ? json(info()) : json({ error: "not permitted" }, 403));
  await assert.rejects(exe.new(), (err) => {
    assert.ok(err instanceof VMReadyError);
    assert.equal(err.vm.name, "worker");
    assert.ok(err.cause instanceof ExeAPIError);
    assert.equal(err.cause.status, 403);
    return true;
  });
  assert.deepEqual(commands, ["new", "ssh worker true"]);
  assert.equal(time.timers.size, 0);
});

test("readiness deadline bounds a hung request", async (t) => {
  const time = clock(t);
  const { exe } = fixture(() => new Promise(() => {}));
  const waiting = exe.vm("worker").waitUntilReady({ timeoutMs: 50 });
  const rejected = assert.rejects(waiting, (err) => err instanceof VMReadyError && err.cause.name === "TimeoutError");
  await time.fire(50);
  await rejected;
  assert.equal(time.timers.size, 0);
});

test("readiness cancellation interrupts backoff and keeps the caller's reason", async (t) => {
  const time = clock(t);
  const abort = new AbortController();
  const reason = new Error("cancelled by caller");
  const { exe, commands } = fixture(() => json({ error: "failed to connect to VM" }, 422));
  const waiting = exe.vm("worker").waitUntilReady({ signal: abort.signal });
  const rejected = assert.rejects(waiting, (err) => err === reason);
  await time.scheduled(100);
  abort.abort(reason);
  await rejected;
  assert.equal(commands.length, 1);
  assert.equal(time.timers.size, 0);
});

test("invalid readiness options fail before creating anything", async () => {
  const { exe, commands } = fixture(() => json(info()));
  for (const timeoutMs of [0, -1, Infinity, 0.5, 2 ** 31]) {
    await assert.rejects(exe.new({ timeoutMs }), TypeError);
  }
  await assert.rejects(exe.new({ waitUntil: "app" }), TypeError);
  assert.deepEqual(commands, []);
});

test("VM metadata contracts fail explicitly on incompatible server JSON", async () => {
  for (const row of [null, {}, { vm_name: "x" }, { ...info(), tags: "test" }, { ...info(), vm_name: "-lroot" }]) {
    await assert.rejects(fixture(() => json(row)).exe.new({ waitUntil: "created" }), { name: "ExeProtocolError" });
  }
  await assert.rejects(fixture(() => json({ vms: [{}] })).exe.ls(), { name: "ExeProtocolError" });
});
