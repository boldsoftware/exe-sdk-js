import exedev, { VM, VMReadyError, SSHStreamError } from "@exedev/sdk";

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
}

function errors(error: unknown) {
  if (error instanceof VMReadyError) return error.vm.rm();
  if (error instanceof SSHStreamError) console.log(error.stdout, error.code);
}
void publicAPI;
void errors;
