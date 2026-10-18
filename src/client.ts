import { Commands } from "./commands.gen.js";
import type { Arg, CallOptions, FlagKind } from "./commands.gen.js";

export interface ExedevOptions {
  /** Bearer token (exe0.* or exe1.*). */
  token: string;
  /** Base URL for the API. Defaults to "https://exe.dev". */
  baseURL?: string;
  /** fetch implementation. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** @deprecated Use CallOptions. */
export type ExecOptions = CallOptions;

export interface ExecResult {
  /** HTTP status code. */
  status: number;
  /** Raw response body; for ssh, the command's output. */
  body: string;
  /** Whether the command succeeded: a 2xx status and, for ssh, exit code 0. */
  ok: boolean;
  /** For ssh, the remote command's exit code. */
  exitCode?: number;
}

/** The result of {@link ExedevClient.ssh}. */
export interface SSHResult {
  /** The remote command's exit code. */
  exitCode: number;
  /** The command's stdout and stderr, combined, as the VM wrote them. */
  output: Uint8Array;
  /** Returns output decoded as UTF-8. */
  text(): string;
}

/**
 * An exe.dev API client. Each exe.dev command is a method (see Commands);
 * exec runs a raw command line.
 *
 * Command methods resolve to the command's parsed JSON output and reject with
 * ExeAPIError when the command fails.
 */
export class ExedevClient extends Commands {
  readonly #token: string;
  readonly #baseURL: string;
  readonly #fetch: typeof fetch;

  constructor(opts: ExedevOptions) {
    super();
    if (!opts?.token) {
      throw new Error("exedev: token is required");
    }
    this.#token = opts.token;
    this.#baseURL = (opts.baseURL ?? "https://exe.dev").replace(/\/$/, "");
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Executes a raw command line against the exe.dev API. */
  async exec(command: string, options?: CallOptions): Promise<ExecResult> {
    const res = await this.#post(command, options);
    if (isNDJSON(res)) {
      const { output, exitCode } = await readSSHOutput(command, res);
      return { status: res.status, body: decodeUTF8(output), ok: res.ok && exitCode === 0, exitCode };
    }
    const body = await res.text();
    return { status: res.status, body, ok: res.ok };
  }

  /**
   * Runs a shell command on a VM, like `ssh <vm> <command>`, and resolves
   * when it exits. A nonzero exit code is a result, not an error; ExeAPIError
   * means the command never ran (no such VM, not permitted, ...). The API
   * token must allow the ssh command.
   *
   * @param vm The VM's name, optionally as user@name.
   * @param command A command line for the VM's shell.
   */
  async ssh(vm: string, command: string, options?: CallOptions): Promise<SSHResult> {
    const line = `ssh ${quote(vm)} ${quote(command)}`;
    const res = await this.#post(line, options);
    if (!isNDJSON(res)) {
      throw new ExeAPIError(line, res.status, await res.text());
    }
    const { output, exitCode } = await readSSHOutput(line, res);
    return { exitCode, output, text: () => decodeUTF8(output) };
  }

  #post(command: string, options: CallOptions | undefined): Promise<Response> {
    return this.#fetch(`${this.#baseURL}/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "text/plain",
        // ssh otherwise sends its exit code in a trailer, which fetch cannot
        // read; NDJSON puts it in the body. Other commands ignore this.
        Accept: "application/json, application/x-ndjson",
      },
      body: command,
      signal: options?.signal,
    });
  }

  protected async run(
    path: string,
    args: readonly Arg[],
    options: CallOptions | undefined,
    flags: Readonly<Record<string, FlagKind>>,
  ): Promise<any> {
    const command = commandLine(path, args, options, flags);
    const result = await this.exec(command, options);
    if (!result.ok) {
      throw new ExeAPIError(command, result.status, result.body);
    }
    const docs = parseDocuments(result.body);
    if (docs === undefined) {
      return result.body;
    }
    // Some commands report a failure as an {"error": ...} document with a
    // 200 status (e.g. rm of a missing VM).
    if (docs.some(isErrorDocument)) {
      throw new ExeAPIError(command, result.status, result.body);
    }
    return docs.length === 1 ? docs[0] : docs;
  }
}

/**
 * Create an exe.dev API client.
 *
 * @example
 * ```ts
 * import exedev from "@exedev/sdk";
 *
 * const exe = exedev({ token: process.env.EXE_TOKEN! });
 * const { vms } = await exe.ls();
 * console.log(vms);
 * ```
 */
export default function exedev(opts: ExedevOptions): ExedevClient {
  return new ExedevClient(opts);
}

/** Builds the command line for a generated command method. */
export function commandLine(
  path: string,
  args: readonly Arg[],
  options: CallOptions | undefined,
  flags: Readonly<Record<string, FlagKind>>,
): string {
  const words = [path];
  for (const [key, value] of Object.entries(options ?? {})) {
    if (key === "signal" || value === undefined) {
      continue;
    }
    const kind = Object.hasOwn(flags, key) ? flags[key] : undefined;
    switch (kind) {
      case "bool":
        words.push(value ? `--${key}` : `--${key}=false`);
        break;
      case "number":
      case "string":
        words.push(`--${key}=${quote(String(value))}`);
        break;
      case "repeated":
        for (const v of [value].flat()) {
          words.push(`--${key}=${quote(String(v))}`);
        }
        break;
      default:
        throw new TypeError(`${path}: unknown option ${JSON.stringify(key)}`);
    }
  }
  const positionals: string[] = [];
  let skipped = false;
  for (const arg of args) {
    if (arg === undefined) {
      skipped = true;
      continue;
    }
    for (const a of [arg].flat()) {
      if (skipped) {
        throw new TypeError(`${path}: argument ${JSON.stringify(a)} follows an omitted argument`);
      }
      positionals.push(a);
    }
  }
  if (positionals.some((p) => p.startsWith("-"))) {
    words.push("--");
  }
  words.push(...positionals.map(quote));
  return words.join(" ");
}

/** Quotes s for the exe.dev command-line parser (POSIX shell rules). */
export function quote(s: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) {
    return s;
  }
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

function isNDJSON(res: Response): boolean {
  const type = res.headers.get("Content-Type") ?? "";
  return type.split(";")[0].trim().toLowerCase() === "application/x-ndjson";
}

/**
 * Reads an ssh response in NDJSON: {"output": base64} lines, then one
 * {"exit_code": n}. A body that ends without the exit code, or breaks off, is
 * the output of a command whose connection ended before it did.
 */
async function readSSHOutput(command: string, res: Response): Promise<{ output: Uint8Array; exitCode: number }> {
  const chunks: Uint8Array[] = [];
  let exitCode: number | undefined;
  const frame = (line: string) => {
    if (line.trim() === "") {
      return;
    }
    const f = JSON.parse(line);
    if (typeof f.output === "string") {
      chunks.push(decodeBase64(f.output));
    } else if (typeof f.exit_code === "number") {
      exitCode = f.exit_code;
    }
  };
  const cutOff = (cause?: unknown) =>
    new Error(`exedev: ${command}: output ended before the command exited`, { cause });
  const decoder = new TextDecoder();
  let pending = "";
  const reader = res.body?.getReader();
  while (reader) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw cutOff(err);
    }
    if (chunk.done) {
      break;
    }
    const lines = (pending + decoder.decode(chunk.value, { stream: true })).split("\n");
    pending = lines.pop()!;
    lines.forEach(frame);
  }
  frame(pending + decoder.decode());
  if (exitCode === undefined) {
    throw cutOff();
  }
  return { output: concat(chunks), exitCode };
}

function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function decodeUTF8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Parses a response body as one JSON document, or as newline-separated
 * documents. Returns undefined for an empty or non-JSON body.
 */
function parseDocuments(body: string): unknown[] | undefined {
  const text = body.trim();
  if (text === "") {
    return undefined;
  }
  try {
    return [JSON.parse(text)];
  } catch {
    // Not a single document.
  }
  try {
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  } catch {
    return undefined;
  }
}

function isErrorDocument(doc: unknown): boolean {
  return typeof doc === "object" && doc !== null && !Array.isArray(doc) &&
    Object.keys(doc).length === 1 && "error" in doc;
}

/** Error thrown when the exe.dev API reports a failed command. */
export class ExeAPIError extends Error {
  public readonly command: string;
  public readonly status: number;
  public readonly body: string;

  constructor(command: string, status: number, body: string) {
    super(`exe.dev API error (${status}): ${errorMessage(body)}`);
    this.name = "ExeAPIError";
    this.command = command;
    this.status = status;
    this.body = body;
  }
}

function errorMessage(body: string): string {
  for (const doc of parseDocuments(body) ?? []) {
    if (isErrorDocument(doc)) {
      return String((doc as { error: unknown }).error);
    }
  }
  return body.trim();
}
