# @exedev/sdk

Official JavaScript/TypeScript SDK for the [exe.dev](https://exe.dev) HTTPS API.

```sh
npm install @exedev/sdk
```

## Quick start

```ts
import exedev from "@exedev/sdk";

const exe = exedev({ token: process.env.EXE_TOKEN! });
const vm = await exe.new({ name: "my-vm", image: "ubuntu:24.04", tag: ["dev"] });
// new waits for SSH by default. No create-then-ssh retry loop is needed.
try {
  console.log(vm.name, vm.httpsUrl);
  const result = await vm.ssh("uname -a");
  console.log(result.exitCode, result.stdout, result.stderr);
  await vm.shareAdd("friend@example.com", { message: "have a look" });
} finally {
  await vm.rm();
}
```

## Client and VM API

`exedev({ token, baseURL?, fetch? })` creates a client. `baseURL` defaults to
`https://exe.dev`; `fetch` defaults to the global implementation. Named imports
of `exedev`, `ExedevClient`, and `VM` are also available.

- `exe.new(options?)` creates a VM and returns a `VM` object.
- `exe.ls(nameOrPattern?, options?)` returns `VM[]`.
- `exe.vm(name)` references an existing VM without making a request.
- `vm.refresh(options?)` refreshes its metadata and returns the same object.
- `vm.ssh(command, options?)` runs a shell command on that VM.
- `vm.cp({ name?, ...options })` copies it and returns a new `VM` object.
- `exe.rm(vms)` deletes an array of VMs or names in one request; the server
  deletes several at a time. It resolves to `{ deleted, failed, not_found,
  errors }` rather than throwing for VMs it could not delete.
- Lifecycle and VM-scoped commands are methods on the VM: `vm.rm()`,
  `vm.pause()`, `vm.resume()`, `vm.restart()`, `vm.rename(newName)`,
  `vm.resize(options)`, `vm.stat(options)`, `vm.tag(tags)`, `vm.comment(text)`,
  `vm.shareShow()`, `vm.sharePort(port)`, and the other generated VM commands.
- Account commands remain on the client: `exe.whoami()`, `exe.sshKeyList()`,
  `exe.integrationsList()`, `exe.billingPlan()`, etc.

There is no parallel raw-command API or client-level `ssh` or `cp`. `vm.rm()`
throws `ExeAPIError` if the VM is not deleted, with `status` 404 if it does not
exist.
Options for generated commands retain CLI flag names (for example,
`{ "no-email": true }`); each method carries the server's help text.
Every VM command except `grantSupportRoot`, and `whoami`, has a known JSON
response: its method rejects anything else and resolves to the response's
type. The wire types (`VMRecord`, `NewResponse`, `ShareShowResponse`, ...) are
exported. A few report a problem in the result rather than as an error:
`domainAdd` when DNS does not point at exe.dev yet and `shelleyInstall` when
Shelley is missing; narrow with `"error" in result`. Other account commands
may return JSON or text and are typed as `unknown`.

`vm.name` is the current name. `vm.httpsUrl`, `vm.sshDest`, and `vm.tags` expose
common metadata. `vm.info` is a read-only snapshot with `status`, `region`,
`comment`, `createdAt`, and `promptError` (why `new`'s `prompt` did not reach
Shelley) when available. A reference from `exe.vm(name)` initially knows only
its name, with no tags; call `refresh()` to fetch the rest. A copy from `cp()`
has the tags and web URL the server reports for it. The SDK's own operations
update the snapshot: a VM that passed a readiness wait is `running`, and
`pause()`, `resume()`, `comment()`, and `tag()` record what they changed. A
successful `rename()` updates the same object and invalidates old destinations.
Other references, and changes made elsewhere, need `refresh()`.

## Readiness and cancellation

`new`, `cp`, `restart`, and `resume` wait for SSH by default. Pass
`{ waitUntil: "created" }` to return without probing, including when the token
has no `ssh` permission. `vm.waitUntilReady({ waitUntil?, timeoutMs?, signal? })`
explicitly waits later. The default readiness deadline is 60 seconds **after**
creation or the lifecycle operation returns, including probe requests and backoff.

Readiness runs only the harmless command `true`, retrying transient connection
failures. It never retries a user command or the creation request, and it does
not wait for application servers.

`{ waitUntil: "setup" }` also waits for the VM's setup script (`new`'s
`"setup-script"`, run by exeuntu's `exe-setup.service`) to finish, polling the
unit over SSH with a default deadline of 10 minutes. If the script failed, the
`VMReadyError`'s `cause` is a `VMSetupError` with `exitCode` (or `signal`) and
systemd's `result`; `details().output` has the end of its journal. Only exeuntu,
the default image, and images built on it run setup scripts: on others, such
as `ubuntu:24.04`, the script is not run, and waiting for it is a
`VMSetupError` with `result` `"unsupported"`. Without a script there is nothing
to wait for, and once a script has run, a later restart does not wait for it.

```ts
const vm = await exe.new({ "setup-script": "#!/bin/sh\nsudo apt-get install -y jq", waitUntil: "setup" });
```

If waiting fails, `VMReadyError.vm` gives you the VM for inspection or cleanup;
it is not automatically deleted. That includes a token without `ssh`
permission: the probe is refused, and the error says to use
`waitUntil: "created"`. All operations accept an `AbortSignal`.
Caller cancellation preserves `signal.reason`, including during streaming and
callbacks, rather than wrapping it in another error. An aborted creation may
still have created a VM; use an explicit name or `ls()` to recover it.

## Running commands

`vm.ssh()` resolves to `{ exitCode, stdout, stderr, stdoutBytes, stderrBytes,
captured }`. A nonzero exit code is a result, not an exception; a command killed
by signal N exits 128+N, as in a shell. Byte arrays preserve binary output;
strings are decoded as UTF-8. The command is a shell script: quote any untrusted
values you interpolate into it with `quote`.

```ts
import { quote } from "@exedev/sdk";
await vm.ssh(`cat ${quote(path)}`);
```

Commands run in a non-login shell. Variables from `new`'s `env` are set for
them (once the VM's exe-init has the update that does so; until then use
`bash -lc`). Long silent commands are fine: the server keeps the response alive.

```ts
await vm.ssh("make", {
  capture: false,
  onStdout: (chunk) => { process.stdout.write(chunk); },
  onStderr: (chunk) => { process.stderr.write(chunk); },
});
```

Callbacks are awaited serially, with incremental UTF-8 decoding per stream.
Their cross-stream order is approximate. Throwing from a callback cancels the
response and rejects with that error.

Output is captured by default, with an **8 MiB combined limit** on stdout and
stderr. Change it with `maxOutputBytes`; exceeding it cancels the response and
throws `SSHStreamError` with code `output_limit`. Set `capture: false` for
bounded-memory streaming of arbitrarily long output: callbacks still receive
it, but result/error output is empty and `captured` is false. The capture limit
is ignored in this mode. Invalid or oversized NDJSON frames are always rejected.

## Errors

- `ExeAPIError`: `operation` and HTTP `status`. The message includes the
  server's error text, on one line, without terminal escapes or other control
  characters, and shortened to 200 characters, for example
  `exe.dev API error (422) during ssh: VM "web" is not running`. It never
  includes the request, but the server's text can mention values you sent.
  `error.details().body` has the full response; this may contain secrets.
- `ExeNetworkError`: the request failed before a complete response arrived,
  such as a network error or a connection lost while reading the response.
  `operation` names the command, and the message the system error code when
  there is one. Whether the operation took effect is unknown: `new` may have
  created a VM, so pass a `name` if you need to find it again. `details().cause`
  has the transport's error.
- `ExeProtocolError`: an incompatible response, including malformed JSON or a
  server that does not support NDJSON SSH output.
- `SSHStreamError`: interrupted/invalid output or a capture limit. `code` is
  `interrupted`, `protocol`, or `output_limit`; getters provide captured partial
  output. The exit status is unknown. A request that fails before a response
  (for example, a network error) is `interrupted` too, since the command may
  have started. `details()` exposes opt-in diagnostics: the server's message or
  the transport's error.
- `VMReadyError`: readiness failed; `vm` and `cause` are available.
- `VMSetupError`: the setup script failed or did not run; the `cause` of a
  `VMReadyError`.

Errors do not establish that an operation never ran. Do not blindly retry a
mutation or remote command after a transport failure.

## Authentication

Generate a token via SSH:

```sh
ssh exe.dev ssh-key generate-api-key --label=my-app --exp=30d --cmds="new,ls,ssh,share add,rm"
```

See the [HTTPS API docs](https://exe.dev/docs/https-api) for permissions and scoping.

## Development

**All of `src/` is generated.** Edit `cmd/gensdkjs` and its TypeScript templates
in the exe.dev repository, then run `go run ./cmd/gensdkjs` there. Copy the
outputs into this checkout and test:

```sh
npm install
npm run sync-commands -- ../exe
npm test
```

`npm test` builds the package, checks the public TypeScript API, and runs unit
and live integration tests. Live tests require a tag-scoped token and create,
copy, execute commands on, restart, rename, and delete their own test VMs.
They read `$EXE_TOKEN`, or `$EXE_TOKEN_FILE` (a bare token or JSON containing
`token`), or `~/.config/exedev/sdk-test-token`. The expected tag is `sdk-test`
(override with `$EXE_TEST_TAG`). Set `$EXE_BASE_URL` to test another
deployment, such as `https://exe-staging.dev`. To create a test token:

```sh
ssh exe.dev 'ssh-key generate-api-key --label=sdk-test --tag=sdk-test --exp=30d --cmds="ls,new,whoami,stat,rm,restart,rename,cp,ssh,ssh-key list,share show" --json'
```

Set `EXE_SKIP_INTEGRATION=1` to run without live access. Set
`EXE_SKIP_SSH_INTEGRATION=1` to exercise only the live control plane when the
server has not yet deployed NDJSON SSH support; this explicitly skips live SSH
and readiness assertions, not the corresponding unit tests. The full live
suite requires that protocol and does not silently fall back to raw SSH output.

The generator's Go tests check regeneration and command grammar assumptions.
Server-side wire-contract tests exercise creation, listing, copying, and SSH.
To run the generated SDK end-to-end against the local Go HTTP/SSH fixture:

```sh
# In the exe.dev checkout, with this SDK's npm dependencies installed:
EXE_SDK_JS_DIR=/absolute/path/to/exe-sdk-js go test ./execore -run TestSDKJSHTTP
```

## License

MIT
