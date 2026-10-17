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

// List all VMs
const vms = await exe.ls();
console.log(vms);

// Get your identity
const me = await exe.whoami();
console.log(me.email);

// Create a VM
await exe.new("my-vm", { image: "ubuntu:24.04" });

// Get VM details
const info = await exe.stat("my-vm");
console.log(info);

// Run any command
const result = await exe.exec("help");
console.log(result.body);

// Delete a VM
await exe.rm("my-vm");
```

## Authentication

Generate an API token via SSH:

```sh
ssh exe.dev token
```

See the [HTTPS API docs](https://exe.dev/docs/https-api) for full details on
authentication, token permissions, and scoping.

## API

### `exedev(options)`

| Option    | Type   | Required | Default             |
| --------- | ------ | -------- | ------------------- |
| `token`   | string | Yes      |                     |
| `baseURL` | string | No       | `https://exe.dev`   |

### Methods

| Method | Description |
| --- | --- |
| `exec(command)` | Run any command (raw) |
| `ls()` | List VMs |
| `whoami()` | Get authenticated user |
| `stat(vmName)` | Get VM details |
| `new(name?, options?)` | Create a VM (`options`: `image`, `tags`); returns its name |
| `rm(vmName)` | Delete a VM |
| `restart(vmName)` | Restart a VM |
| `rename(oldName, newName)` | Rename a VM |
| `sshKeyList()` | List SSH keys |
| `shareShow(vmName)` | Show sharing settings |

All methods accept an optional `{ signal: AbortSignal }` as the last argument for cancellation.

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
restart, rename and delete a VM. They need a tag-scoped API token, which can
only see and touch VMs with its tag, and they fail without one (set
`EXE_SKIP_INTEGRATION=1` to skip them). To create the token:

```sh
mkdir -p ~/.config/exedev
ssh exe.dev 'ssh-key generate-api-key --label=sdk-test --tag=sdk-test --exp=30d --cmds="help,ls,new,whoami,stat,rm,restart,rename,ssh-key list,share show" --json' \
  | jq -r .token > ~/.config/exedev/sdk-test-token
chmod 600 ~/.config/exedev/sdk-test-token
```

The tests read the token from `$EXE_TOKEN` or `~/.config/exedev/sdk-test-token`.
They check that the VM they create is tagged `sdk-test` (override with
`$EXE_TEST_TAG`). Revoke the token with `ssh exe.dev ssh-key remove sdk-test`.

## License

MIT
