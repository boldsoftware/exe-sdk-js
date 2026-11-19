# Changelog

## 0.5.0

Synced with the exe.dev server's commands as of 2026-11-19.

New:
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
- Readiness retries only failures the server marks `vm_unreachable`, rather
  than matching its error text.

Removed:
- `exe.poolHosts()`: the server no longer has `pool hosts`.

Docs: the README's token command quotes `--cmds` so the token gets every
command listed; the quick start no longer emails an invitation to an example
address; runtime and CommonJS support, egress, and token scoping are
documented.
