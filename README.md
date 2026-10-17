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

## License

MIT
