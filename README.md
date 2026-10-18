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
- Lifecycle and VM-scoped commands are methods on the VM: `vm.rm()`,
  `vm.pause()`, `vm.resume()`, `vm.restart()`, `vm.rename(newName)`,
  `vm.resize(options)`, `vm.stat(options)`, `vm.tag(tags)`, `vm.comment(text)`,
  `vm.shareShow()`, `vm.sharePort(port)`, and the other generated VM commands.
- Account commands remain on the client: `exe.whoami()`, `exe.sshKeyList()`,
  `exe.integrationsList()`, `exe.billingPlan()`, etc.

There is no parallel raw-command API or client-level `ssh`, `cp`, or `rm`.
Options for generated commands retain CLI flag names (for example,
`{ "no-email": true }`); each method carries the server's help text.
Methods with known JSON responses reject malformed JSON; other account/VM
commands may return JSON or text and are typed as `unknown`.

`vm.name` is the current name. `vm.httpsUrl`, `vm.sshDest`, and `vm.tags` expose
common metadata. `vm.info` is a read-only snapshot with `status`, `region`,
`comment`, `createdAt`, and `setupError` when available. A reference from
`exe.vm(name)` initially knows only its name. Copies do not invent a web URL;
call `refresh()` to fetch it. A successful `rename()` updates the same object
and invalidates old destinations; other references do not automatically change.

## Readiness and cancellation

`new`, `cp`, `restart`, and `resume` wait for SSH by default. Pass
`{ waitUntil: "created" }` to return without probing, including when the token
has no `ssh` permission. `vm.waitUntilReady({ timeoutMs?, signal? })` explicitly
waits later. The default readiness deadline is 60 seconds **after** creation or
the lifecycle operation returns, including probe requests and backoff.

Readiness runs only the harmless command `true`, retrying transient connection
failures. It does not wait for application servers or setup scripts, and it
never retries a user command or the creation request.

If waiting fails, `VMReadyError.vm` gives you the VM for inspection or cleanup;
it is not automatically deleted. All operations accept an `AbortSignal`.
Caller cancellation preserves `signal.reason`, including during streaming and
callbacks, rather than wrapping it in another error. An aborted creation may
still have created a VM; use an explicit name or `ls()` to recover it.

## Running commands

`vm.ssh()` resolves to `{ exitCode, stdout, stderr, stdoutBytes, stderrBytes,
captured }`. A nonzero exit code is a result, not an exception. Byte arrays
preserve binary output; strings are decoded as UTF-8. The command is a shell
script: quote any untrusted values you interpolate into it.

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

- `ExeAPIError`: `operation` and HTTP `status`. The message, stack, and ordinary
  serialization omit request arguments and server response bodies. Explicitly
  call `error.details().body` for diagnostics; this may contain secrets.
- `ExeProtocolError`: an incompatible response, including malformed JSON or a
  server that does not support NDJSON SSH output.
- `SSHStreamError`: interrupted/invalid output or a capture limit. `code` is
  `interrupted`, `protocol`, or `output_limit`; getters provide captured partial
  output. The exit status is unknown. `details()` exposes opt-in server diagnostics.
- `VMReadyError`: readiness failed; `vm` and `cause` are available.

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
