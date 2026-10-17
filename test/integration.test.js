// Integration tests against the real exe.dev API. Skipped unless EXE_TOKEN
// is set. Creates and deletes a VM, so use a tag-scoped token: VMs created
// with it are tagged automatically, and it cannot touch any other VM.
import { test } from "node:test";
import assert from "node:assert/strict";
import exedev from "../dist/index.js";

const token = process.env.EXE_TOKEN;
const skip = token ? false : "EXE_TOKEN not set";

test("VM lifecycle", { skip, timeout: 120_000 }, async (t) => {
  const exe = exedev({ token, baseURL: process.env.EXE_BASE_URL });
  const name = `sdk-test-${Date.now().toString(36)}`;

  const me = await exe.whoami();
  assert.match(me.email, /@/);

  assert.equal(await exe.new(name), name);
  t.after(() => exe.rm(name).catch(() => {}));

  const vms = await exe.ls();
  assert.ok(vms.some((vm) => vm.vm_name === name), `${name} not in ls`);

  await exe.rm(name);
  const after = await exe.ls();
  assert.ok(!after.some((vm) => vm.vm_name === name), `${name} still in ls after rm`);
});
