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
  /** Raw response body. */
  body: string;
  /** Whether the request succeeded (2xx). */
  ok: boolean;
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
    const res = await this.#fetch(`${this.#baseURL}/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "text/plain",
      },
      body: command,
      signal: options?.signal,
    });
    const body = await res.text();
    return { status: res.status, body, ok: res.ok };
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
