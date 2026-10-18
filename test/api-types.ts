import exedev, { VM, VMReadyError, VMSetupError, SSHStreamError, quote } from "@exedev/sdk";
import type { RmResponse, NewResponse, VMRecord, WaitOptions } from "@exedev/sdk";

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

function errors(error: unknown) {
  if (error instanceof VMReadyError && error.cause instanceof VMSetupError) {
    console.log(error.cause.exitCode, error.cause.signal, error.cause.result, error.cause.details().output);
  }
  if (error instanceof VMReadyError) return error.vm.rm();
  if (error instanceof SSHStreamError) console.log(error.stdout, error.code);
}
void publicAPI;
void errors;
