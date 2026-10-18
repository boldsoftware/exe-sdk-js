import exedev, { VM, VMReadyError, VMSetupError, SSHStreamError, quote } from "@exedev/sdk";
import type { RmResponse, NewResponse, VMRecord, WaitOptions, ResumeResponse, ShareShowResponse } from "@exedev/sdk";

async function publicAPI() {
  const exe = exedev({ token: "test" });
  const vm: VM = await exe.new({ name: "worker", timeoutMs: 60_000 });
  const copy: VM = await vm.cp({ name: "copy", waitUntil: "created" });
  await copy.waitUntilReady();
  await vm.ssh("echo hello", {
    capture: false,
    onStdout: async (chunk: string) => { console.log(chunk); },
  });
  for (const listed of await exe.ls()) await listed.stat({ range: "24h" });
  await exe.vm("worker").rename("renamed");
  await vm.restart();
  await vm.rm();
  const me: string = (await exe.whoami()).email;
  console.log(me);
  // @ts-expect-error VM operations are not duplicated on the client.
  await exe.ssh("worker", "true");
  // @ts-expect-error Raw execution is not a parallel API.
  await exe.exec("new");
  // @ts-expect-error new returns a VM, not the wire record.
  console.log(vm.vm_name);
  // @ts-expect-error The bound VM name is not an ssh argument.
  await vm.ssh("worker", "true");
  // @ts-expect-error Resource identity is read-only.
  vm.name = "oops";
  // @ts-expect-error Unsupported readiness state.
  await exe.new({ waitUntil: "app" });
  await exe.new({ waitUntil: "setup", "setup-script": "#!/bin/sh\napt-get install -y jq" });
  const wait: WaitOptions = { waitUntil: "setup", timeoutMs: 900_000 };
  await vm.waitUntilReady(wait);
  // @ts-expect-error waitUntilReady always waits for something.
  await vm.waitUntilReady({ waitUntil: "created" });
  const reaped: RmResponse = await exe.rm([vm, "other"]);
  console.log(reaped.deleted, reaped.not_found, reaped.errors?.other);
  // @ts-expect-error A string is not a list of VMs.
  await exe.rm("worker");
  await vm.ssh(`cat ${quote("/tmp/it's here")}`);
  // Wire types are exported for callers that use the generated record shapes.
  const records: [VMRecord?, NewResponse?] = [];
  console.log(records, vm.info.promptError);
}

// VM commands with a JSON response resolve to its type, not unknown.
async function results(vm: VM) {
  const paused: "paused" = (await vm.pause()).status;
  const tags: string[] = (await vm.tag("prod")).tags;
  const grown: number | undefined = (await vm.resize({ disk: "250GB" })).disk_new_bytes;
  const added = await vm.domainAdd("app.example.com");
  // A DNS problem is in-band: narrow before reading the added domain.
  if ("error" in added) console.log(added.error, "expected" in added ? added.expected : added.delegation_target);
  else console.log(added.wildcard);
  // @ts-expect-error wildcard is absent when domain add reports a DNS problem.
  console.log(added.wildcard);
  const shared: ShareShowResponse = await vm.shareShow();
  const level: "web" | "root" = shared.users[0].share_level;
  const added2 = await vm.shareAdd("friend@example.com");
  if (added2.status === "updated" && "share_level" in added2) console.log(added2.share_level);
  const installed = await vm.shelleyInstall();
  if ("error" in installed) console.log(installed.download_url);
  // resume returns the VM; its wire response is for callers of the raw shape.
  const cold: ResumeResponse["cold_booted"] = "true";
  // @ts-expect-error cold_booted is the string "true" or "false" on the wire.
  const coldBool: ResumeResponse["cold_booted"] = true;
  // @ts-expect-error grant-support-root writes no JSON, so its result is unknown.
  console.log((await vm.grantSupportRoot("on")).status);
  console.log(paused, tags, grown, level, cold, coldBool);
}

function errors(error: unknown) {
  if (error instanceof VMReadyError && error.cause instanceof VMSetupError) {
    console.log(error.cause.exitCode, error.cause.signal, error.cause.result, error.cause.details().output);
  }
  if (error instanceof VMReadyError) return error.vm.rm();
  if (error instanceof SSHStreamError) console.log(error.stdout, error.code);
}
void publicAPI;
void errors;
void results;
