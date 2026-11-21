# Changelog

## 0.6.1

0.6.0 was not published on npm; 0.6.1 is 0.6.0 and this change.

Changed:
- Requests send `User-Agent: exedev-js/VERSION`, as the Python SDK sends
  `exedev-python/VERSION`, and `VERSION` is exported. `npm run build` and
  `npm version` write it from package.json to src/version.ts.

## 0.6.0

Synced with the exe.dev server's commands as of 2026-11-21. 0.5.0 was never
published; its changes are here.

New:
- Files on a VM: `vm.writeFile()`, `vm.readFile()`, `vm.upload()`, and
  `vm.download()`, with `VMFileError` and `CommandError`.
- `onStdoutBytes` and `onStderrBytes`: `vm.ssh()` callbacks with raw bytes.
- `exe.exec(line)` runs any command line, for commands without a method.
- The token defaults to `$EXE_TOKEN`.
- `signToken()` signs API and VM tokens locally from an OpenSSH key.
- Egress policy: `exe.new({ egress: "integrations" })` and `vm.cp({ egress })`
  set what a VM may reach at creation; `vm.egress(policy?)` shows or changes
  it; `vm.info.egressPolicy` and the `egress_policy` of `ls`, `new`, and `cp`
  results report it (`EgressPolicy`, `EgressResponse`).
- `exe.sshKeyGenerateApiKey()` resolves to a typed `GenerateAPIKeyResponse`,
  and takes `tag` (a key that manages only VMs with that tag) and `ips`.
- `exe.sshKeyAdd()` takes `vm` (one or several VMs), `ssh-user`, and `ips`. An
  empty `vm` list is a `TypeError`, rather than a key that reaches every VM.
- `exe.integrationsShow(name)`, `exe.integrationsSetupExeconnect()`,
  `exe.teamSettingsPublicSharing()`; `integrationsList({ available })`,
  `integrationsSetupGithub({ repos })`, `integrationsAdd`/`Edit` External
  Connection and step-up options, `poolList({ format, fields })`,
  `billingUsage({ history })`, `teamSettingsVmSharing("off")`.
- `ResizeResponse.restart_required`; `NewResponse.created_at`; `CpResponse`
  reports `comment` and `created_at`.
- Requests send `User-Agent: exedev-js`.

Changed:
- **Breaking:** `vm.resume()` resolves to the server's result, with
  `cold_booted`, instead of the VM.
- Readiness retries only failures the server marks `vm_unreachable`, rather
  than matching its error text.

Removed:
- `exe.poolHosts()`: the server no longer has `pool hosts`.

Known issue: since VMs' SSH server stopped killing a session's command when
its connection drops (exe, 2026-11-06), aborting `vm.ssh()` leaves the command
running on the VM; the README now says so.

Docs: the README's token command quotes `--cmds` so the token gets every
command listed; the quick start no longer emails an invitation to an example
address; runtime and CommonJS support, egress, and token scoping are
documented.
