// Integration tests against the real exe.dev API.
//
// These need a tag-scoped API token (see "Development" in README.md), read
// from $EXE_TOKEN or ~/.config/exedev/sdk-test-token. They fail without one;
// set EXE_SKIP_INTEGRATION=1 to skip them instead.
//
// The tests create, restart, rename, and delete a VM. A tag-scoped token
// tags every VM it creates and can see or touch no other VM, and the tests
// check that the VM they create carries the expected tag ($EXE_TEST_TAG,
// default "sdk-test").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import exedev, { ExeAPIError } from "../dist/index.js";

const tokenFile = join(homedir(), ".config", "exedev", "sdk-test-token");
const tag = process.env.EXE_TEST_TAG || "sdk-test";

function loadToken() {
  if (process.env.EXE_TOKEN) {
    return process.env.EXE_TOKEN.trim();
  }
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

const token = loadToken();
const skip = process.env.EXE_SKIP_INTEGRATION ? "EXE_SKIP_INTEGRATION is set" : false;

test("integration", { skip, timeout: 300_000 }, async (t) => {
  assert.ok(
    token,
    `no API token: set EXE_TOKEN or write one to ${tokenFile} ` +
      `(see "Development" in README.md), or set EXE_SKIP_INTEGRATION=1`,
  );
  const exe = exedev({ token, baseURL: process.env.EXE_BASE_URL });
  const name = `sdk-test-${Date.now().toString(36)}`;
  const renamed = `${name}-r`;
  const copy = `${name}-c`;
  const missing = `${name}-missing`;

  t.after(async () => {
    // Best-effort cleanup if a step below failed partway.
    for (const vm of [name, renamed, copy]) {
      await exe.rm(vm).catch(() => {});
    }
  });

  await t.test("whoami", async () => {
    const me = await exe.whoami();
    assert.match(me.email, /@/);
    assert.equal(typeof me.region, "string");
    assert.ok(Array.isArray(me.ssh_keys));
  });

  await t.test("exec", async () => {
    const res = await exe.exec("help");
    assert.equal(res.status, 200);
    assert.ok(res.ok);
    assert.ok(Array.isArray(JSON.parse(res.body).commands));
  });

  await t.test("new", async () => {
    const vm = await exe.new({ name, comment: "sdk integration test" });
    assert.equal(vm.vm_name, name);
    assert.ok(vm.tags.includes(tag), `new returned tags ${JSON.stringify(vm.tags)}, want ${tag}`);
  });

  await t.test(`ls shows the new VM, tagged ${tag}`, async () => {
    const vm = (await exe.ls()).vms.find((vm) => vm.vm_name === name);
    assert.ok(vm, `${name} not in ls`);
    assert.ok(
      vm.tags.includes(tag),
      `${name} has tags ${JSON.stringify(vm.tags)}, want ${tag}: is the token tag-scoped?`,
    );
    assert.match(vm.ssh_dest, new RegExp(`^${name}\\.`));
    assert.match(vm.https_url, /^https:\/\//);
    assert.equal(vm.comment, "sdk integration test");
    assert.ok(Math.abs(Date.parse(vm.created_at) - Date.now()) < 3_600_000, `created_at ${vm.created_at}`);
  });

  await t.test("ssh", async () => {
    // The VM is running before its sshd accepts connections.
    let res;
    for (let deadline = Date.now() + 60_000; ; ) {
      try {
        res = await exe.ssh(name, "echo to-stdout; echo to-stderr >&2; exit 7");
        break;
      } catch (err) {
        if (!(err instanceof ExeAPIError) || !/failed to/.test(err.message) || Date.now() > deadline) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    assert.equal(res.exitCode, 7);
    assert.match(res.text(), /to-stdout/);
    assert.match(res.text(), /to-stderr/);
  });

  await t.test("cp", async () => {
    const vm = await exe.cp(name, copy);
    assert.equal(vm.name, copy);
    assert.equal(vm.source, name);
    assert.equal(vm.state, "starting");
    assert.ok(vm.ssh.includes(copy), `ssh ${vm.ssh}`);
    assert.equal(typeof vm.elapsed, "number");
    assert.deepEqual(await exe.rm(copy), { deleted: [copy], failed: [] });
  });

  await t.test("stat", async () => {
    const st = await exe.stat(name);
    assert.equal(st.name, name);
    assert.equal(typeof st.status, "string");
    assert.equal(typeof st.range, "string");
    assert.ok(st.points === null || Array.isArray(st.points));
  });

  await t.test("ls with a pattern", async () => {
    const { vms } = await exe.ls(name);
    assert.deepEqual(vms.map((vm) => vm.vm_name), [name]);
  });

  await t.test("shareShow", async () => {
    const share = await exe.shareShow(name);
    assert.equal(share.vm_name, name);
  });

  await t.test("sshKeyList", async () => {
    const keys = await exe.sshKeyList();
    assert.ok(Array.isArray(keys.ssh_keys));
  });

  await t.test("restart", async () => {
    assert.deepEqual(await exe.restart(name), { status: "restarted", vm_name: name });
  });

  await t.test("rename", async () => {
    assert.deepEqual(await exe.rename(name, renamed), {
      status: "renamed",
      old_name: name,
      new_name: renamed,
    });
    const names = (await exe.ls()).vms.map((vm) => vm.vm_name);
    assert.ok(names.includes(renamed), `${renamed} not in ls`);
    assert.ok(!names.includes(name), `${name} still in ls`);
  });

  await t.test("rm", async () => {
    assert.deepEqual(await exe.rm(renamed), { deleted: [renamed], failed: [] });
    const names = (await exe.ls()).vms.map((vm) => vm.vm_name);
    assert.ok(!names.includes(renamed), `${renamed} still in ls`);
  });

  await t.test("rm of a missing VM throws", async () => {
    await assert.rejects(exe.rm(missing), ExeAPIError);
  });

  await t.test("a command tag-scoped keys may not run throws 403", async () => {
    await assert.rejects(exe.billingPlan(), (err) => {
      assert.ok(err instanceof ExeAPIError);
      assert.equal(err.status, 403);
      return true;
    });
  });

  await t.test("restart of a missing VM throws", async () => {
    await assert.rejects(exe.restart(missing), (err) => {
      assert.ok(err instanceof ExeAPIError);
      assert.equal(err.status, 422);
      assert.equal(err.command, `restart ${missing}`);
      return true;
    });
  });
});
