import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import exedev, { VM, VMReadyError, VMSetupError, ExeAPIError, SSHStreamError, quote } from "../dist/index.js";

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
  for (const name of ["ssh", "cp", "pause", "resume", "restart", "rename", "resize", "stat", "shareShow", "exec", "run"]) {
    assert.equal(exe[name], undefined, name);
  }
  // The exception: exe.rm takes a list, to delete many VMs in one request.
  assert.equal(typeof exe.rm, "function");
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
    assert.match(err.message, /worker .*may not run ssh.*waitUntil: "created"/);
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

const stdout = (text, code = 0) => new Response(
  `${JSON.stringify({ stdout: Buffer.from(text).toString("base64") })}\n{"exit_code":${code}}\n`,
  { headers: { "Content-Type": "application/x-ndjson" } });
// systemctl show output for exe-setup.service, as observed on exeuntu.
const unitText = (props, system = "running") => Object.entries({
  LoadState: "loaded", ActiveState: "inactive", Result: "success", ExecMainCode: "0", ExecMainStatus: "0",
  ExecMainExitTimestampMonotonic: "0", ConditionResult: "no", ConditionTimestampMonotonic: "0", ...props,
}).map(([k, v]) => `${k}=${v}`).join("\n") + `\nSystemState=${system}\n`;
const unit = (props, system) => stdout(unitText(props, system));

test("waitUntil setup polls the setup unit until its script has run", async (t) => {
  const time = clock(t);
  const states = [
    stdout("State=booting\n"),
    unit({ ActiveState: "inactive", Job: "90" }, "starting"),
    unit({ ActiveState: "activating" }, "starting"),
    unit({ ExecMainCode: "1", ExecMainExitTimestampMonotonic: "123", ConditionResult: "yes", ConditionTimestampMonotonic: "5" }),
  ];
  const { exe, commands } = fixture((command) => command.startsWith("new") ? json(info()) : states.shift());
  const created = exe.new({ waitUntil: "setup" });
  for (let i = 0; i < 3; i++) await time.fire(1000 * 2 ** i > 2000 ? 2000 : 1000 * 2 ** i);
  const vm = await created;
  assert.equal(vm.name, "worker");
  assert.equal(commands.length, 5);
  assert.match(commands[1], /^ssh worker '.*systemctl show exe-setup.service/s);
  assert.ok(commands.slice(1).every((c) => c === commands[1]), "the probe never changes");
  assert.equal(time.timers.size, 0);
});

test("waitUntil setup has nothing to wait for without a script or a setup unit", async () => {
  for (const output of [
    unit({ ConditionTimestampMonotonic: "5", ConditionResult: "no" }),
    unit({ LoadState: "not-found" }),
    stdout("State=unsupported\n"),
    unit({}, "degraded"), // Never started, and the system finished booting.
  ]) {
    const { exe } = fixture(() => output);
    await exe.vm("worker").waitUntilReady({ waitUntil: "setup" });
  }
});

test("a failed setup script rejects with its result and opt-in output", async () => {
  const failed = unitText({ ActiveState: "failed", Result: "exit-code", ExecMainCode: "1", ExecMainStatus: "7", ExecMainExitTimestampMonotonic: "9" }, "degraded");
  const { exe } = fixture((command) => command.startsWith("new") ? json(info()) :
    stdout(`${failed}---\nsecret-token=abc\nboom\n`));
  await assert.rejects(exe.new({ waitUntil: "setup" }), (err) => {
    assert.ok(err instanceof VMReadyError);
    assert.equal(err.vm.name, "worker");
    assert.equal(err.message, "exedev: VM worker setup script failed (exit code 7)");
    assert.ok(err.cause instanceof VMSetupError);
    assert.equal(err.cause.result, "exit-code");
    assert.equal(err.cause.exitCode, 7);
    assert.equal(err.cause.signal, undefined);
    assert.match(err.cause.details().output, /boom/);
    assert.doesNotMatch(inspect(err), /secret-token/);
    return true;
  });
  const killed = fixture(() => unit({ ActiveState: "failed", Result: "signal", ExecMainCode: "2", ExecMainStatus: "9" }));
  await assert.rejects(killed.exe.vm("worker").waitUntilReady({ waitUntil: "setup" }), (err) =>
    err.cause.signal === 9 && err.cause.exitCode === undefined && /\(signal 9\)/.test(err.message));
});

test("waitUntil setup defaults to a ten-minute deadline", async (t) => {
  const time = clock(t);
  const { exe } = fixture(() => new Promise(() => {}));
  const rejected = assert.rejects(exe.vm("worker").waitUntilReady({ waitUntil: "setup" }), (err) =>
    err instanceof VMReadyError && err.cause.name === "TimeoutError" && /setup did not finish in time/.test(err.message));
  await time.fire(600_000);
  await rejected;
  await assert.rejects(exe.vm("worker").waitUntilReady({ waitUntil: "created" }), TypeError);
});

test("readiness probes retry a lost connection; it is safe to rerun them", async (t) => {
  const time = clock(t);
  let calls = 0;
  const { exe } = fixture(() => {
    if (++calls === 1) throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    return exited();
  });
  const ready = exe.vm("worker").waitUntilReady();
  await time.fire(100);
  await ready;
  assert.equal(calls, 2);
});

test("ssh reports a failed request as an interrupted command, keeping the cause opt-in", async () => {
  const { exe } = fixture(() => { throw new TypeError("fetch failed: sensitive-command"); });
  await assert.rejects(exe.vm("worker").ssh("sleep 310"), (err) => {
    assert.ok(err instanceof SSHStreamError);
    assert.equal(err.code, "interrupted");
    assert.equal(err.details().cause.message, "fetch failed: sensitive-command");
    assert.doesNotMatch(inspect(err), /sensitive-command/);
    return true;
  });
  // A caller's cancellation is still the caller's reason.
  const abort = new AbortController();
  const reason = new Error("stop");
  const cancelled = fixture(() => { abort.abort(reason); throw new DOMException("aborted", "AbortError"); });
  await assert.rejects(cancelled.exe.vm("worker").ssh("true", { signal: abort.signal }), (err) => err === reason);
});

test("quote is exported for interpolating values into ssh commands", () => {
  assert.equal(quote("plain-word"), "plain-word");
  assert.equal(quote("it's $HOME"), `'it'"'"'s $HOME'`);
});
