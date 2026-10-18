# @exedev/sdk

Official JavaScript/TypeScript SDK for the [exe.dev](https://exe.dev) HTTPS API.

## Install

```sh
npm install @exedev/sdk
```

## Quick start

```ts
import exedev from "@exedev/sdk";

const exe = exedev({ token: process.env.EXE_TOKEN! });

// Every exe.dev command is a method. Positional arguments are parameters;
// flags go in an options object, spelled as on the command line.
const vm = await exe.new({ name: "my-vm", image: "ubuntu:24.04", tag: ["dev"] });
console.log(vm.https_url);

const { vms } = await exe.ls();
await exe.resize("my-vm", { memory: "8GB" });
await exe.pause("my-vm");
await exe.resume("my-vm");
await exe.shareAdd("my-vm", "friend@example.com", { message: "have a look" });

// Run a command on a VM.
const run = await exe.ssh("my-vm", "uname -a");
console.log(run.exitCode, run.stdout, run.stderr);

await exe.rm("my-vm");

// Run a raw command line.
const result = await exe.exec("help");
console.log(result.body);
```

## Authentication

Generate an API token via SSH:

```sh
ssh exe.dev ssh-key generate-api-key --label=my-app --exp=30d
```

See the [HTTPS API docs](https://exe.dev/docs/https-api) for full details on
authentication, token permissions, and scoping.

## API

### `exedev(options)`

| Option    | Type   | Required | Default             |
| --------- | ------ | -------- | ------------------- |
| `token`   | string | Yes      |                     |
| `baseURL` | string | No       | `https://exe.dev`   |
| `fetch`   | function | No     | global `fetch`      |

### Commands

Each public exe.dev command that runs over the HTTPS API is a method, named by
camel-casing its path: `ls`, `new`, `ssh-key list` is `sshKeyList`,
`team settings auto-join` is `teamSettingsAutoJoin`. Each method's doc comment
is the command's own help text, so `help <command>` and your editor agree.

Methods resolve to the command's JSON output, typed for the commands listed in
`CommandResults` (`src/types.ts`) and `unknown` otherwise. They reject with
`ExeAPIError` (`status`, `command`, `body`) when a command fails. Every
options object accepts `signal` (an `AbortSignal`) for cancellation.

### `ssh(vm, command)`

Runs a shell command on a VM, as `ssh my-vm 'command'` would, and resolves
when it exits, to `{ exitCode, stdout, stderr }`, with the output decoded as
UTF-8; `stdoutBytes` and `stderrBytes` have it byte for byte, for binary
output. A nonzero exit code is a result, not an error. It rejects with
`ExeAPIError` if the command never ran, and with an `Error` if it ran but
its exit code was lost, so its output may be incomplete. The API token needs
the `ssh` command.

`exec("ssh my-vm ...")` reports the exit code too, as `exitCode`, with stdout
and stderr combined in `body`.

### Generated methods

The command methods live in `src/commands.gen.ts`, which is generated from the
exe.dev command tree; don't edit it by hand. To pick up new commands, run
`npm run sync-commands -- path/to/exe` (default `../exe`) with an up-to-date
checkout of the exe.dev repository, then `npm test`.

### Named import

```ts
import { exedev } from "@exedev/sdk";
```

## Development

```sh
npm install
npm test
```

`npm test` builds the package, then runs the unit tests and the integration
tests. The integration tests run against the real exe.dev API and create,
copy, run a command on, restart, rename and delete a VM. They need a
tag-scoped API token, which can only see and touch VMs with its tag, and they
fail without one (set `EXE_SKIP_INTEGRATION=1` to skip them). To create the
token:

```sh
mkdir -p ~/.config/exedev
ssh exe.dev 'ssh-key generate-api-key --label=sdk-test --tag=sdk-test --exp=30d --cmds="help,ls,new,whoami,stat,rm,restart,rename,cp,ssh,ssh-key list,share show" --json' \
  | jq -r .token > ~/.config/exedev/sdk-test-token
chmod 600 ~/.config/exedev/sdk-test-token
```

The tests read the token from `$EXE_TOKEN` or `~/.config/exedev/sdk-test-token`.
They check that the VM they create is tagged `sdk-test` (override with
`$EXE_TEST_TAG`). Revoke the token with `ssh exe.dev ssh-key remove sdk-test`.

## License

MIT
