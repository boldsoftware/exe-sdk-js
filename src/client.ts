import type {
  VM,
  VMListResponse,
  WhoamiResponse,
  StatResponse,
  NewResponse,
} from "./types.js";

export interface ExedevOptions {
  /** Bearer token (exe0.* or exe1.*). */
  token: string;
  /** Base URL for the API. Defaults to "https://exe.dev". */
  baseURL?: string;
}

export interface ExecOptions {
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

export interface ExecResult {
  /** HTTP status code. */
  status: number;
  /** Raw response body. */
  body: string;
  /** Whether the request succeeded (2xx). */
  ok: boolean;
}

export interface NewOptions {
  /** Container image. Defaults to "exeuntu". */
  image?: string;
  /** Tags to add to the VM. */
  tags?: string[];
}

export interface ExedevClient {
  /** Execute a raw command against the exe.dev API. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** List all VMs. */
  ls(opts?: ExecOptions): Promise<VM[]>;
  /** Get the authenticated user's identity. */
  whoami(opts?: ExecOptions): Promise<WhoamiResponse>;
  /** Get detailed status of a VM. */
  stat(vmName: string, opts?: ExecOptions): Promise<StatResponse>;
  /**
   * Create a new VM. Returns the VM name.
   *
   * If `name` is omitted or empty, exe.dev picks one. New VMs are created in
   * the account's region.
   */
  "new"(name?: string, options?: NewOptions, opts?: ExecOptions): Promise<string>;
  /** Delete a VM. */
  rm(vmName: string, opts?: ExecOptions): Promise<void>;
  /** Restart a VM. */
  restart(vmName: string, opts?: ExecOptions): Promise<void>;
  /** Rename a VM. */
  rename(oldName: string, newName: string, opts?: ExecOptions): Promise<void>;
  /** List SSH keys. */
  sshKeyList(opts?: ExecOptions): Promise<string>;
  /** Show sharing settings for a VM. */
  shareShow(vmName: string, opts?: ExecOptions): Promise<string>;
}

/**
 * Create an exe.dev API client.
 *
 * @example
 * ```ts
 * import exedev from "@exedev/sdk";
 *
 * const exe = exedev({ token: process.env.EXE_TOKEN! });
 * const vms = await exe.ls();
 * console.log(vms);
 * ```
 */
export default function exedev(opts: ExedevOptions): ExedevClient {
  if (!opts.token) {
    throw new Error("exedev: token is required");
  }
  const token = opts.token;
  const baseURL = (opts.baseURL ?? "https://exe.dev").replace(/\/$/, "");

  async function exec(command: string, execOpts?: ExecOptions): Promise<ExecResult> {
    const res = await fetch(`${baseURL}/exec`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: command,
      signal: execOpts?.signal,
    });
    const body = await res.text();
    return { status: res.status, body, ok: res.ok };
  }

  async function execJSON<T>(command: string, execOpts?: ExecOptions): Promise<T> {
    const result = await exec(command, execOpts);
    if (!result.ok) {
      throw new ExeAPIError(command, result.status, result.body);
    }
    return JSON.parse(result.body) as T;
  }

  return {
    exec,

    async ls(execOpts?: ExecOptions): Promise<VM[]> {
      const res = await execJSON<VMListResponse>("ls", execOpts);
      return res.vms;
    },

    async whoami(execOpts?: ExecOptions): Promise<WhoamiResponse> {
      return execJSON<WhoamiResponse>("whoami", execOpts);
    },

    async stat(vmName: string, execOpts?: ExecOptions): Promise<StatResponse> {
      return execJSON<StatResponse>(`stat ${vmName}`, execOpts);
    },

    async new(
      name?: string,
      options?: NewOptions,
      execOpts?: ExecOptions,
    ): Promise<string> {
      let cmd = "new";
      if (name) {
        cmd += ` --name=${name}`;
      }
      if (options?.image) {
        cmd += ` --image=${options.image}`;
      }
      if (options?.tags?.length) {
        cmd += ` --tag=${options.tags.join(",")}`;
      }
      const res = await execJSON<NewResponse>(cmd, execOpts);
      return res.vm_name;
    },

    async rm(vmName: string, execOpts?: ExecOptions): Promise<void> {
      const result = await exec(`rm ${vmName}`, execOpts);
      // rm reports a VM it could not delete with a 200 status, an error
      // document, and the VM listed under "failed".
      if (!result.ok || rmFailed(result.body)) {
        throw new ExeAPIError(`rm ${vmName}`, result.status, result.body);
      }
    },

    async restart(vmName: string, execOpts?: ExecOptions): Promise<void> {
      const result = await exec(`restart ${vmName}`, execOpts);
      if (!result.ok) {
        throw new ExeAPIError(`restart ${vmName}`, result.status, result.body);
      }
    },

    async rename(
      oldName: string,
      newName: string,
      execOpts?: ExecOptions,
    ): Promise<void> {
      const result = await exec(`rename ${oldName} ${newName}`, execOpts);
      if (!result.ok) {
        throw new ExeAPIError(
          `rename ${oldName} ${newName}`,
          result.status,
          result.body,
        );
      }
    },

    async sshKeyList(execOpts?: ExecOptions): Promise<string> {
      const result = await exec("ssh-key list", execOpts);
      if (!result.ok) {
        throw new ExeAPIError("ssh-key list", result.status, result.body);
      }
      return result.body;
    },

    async shareShow(vmName: string, execOpts?: ExecOptions): Promise<string> {
      const result = await exec(`share show ${vmName}`, execOpts);
      if (!result.ok) {
        throw new ExeAPIError(
          `share show ${vmName}`,
          result.status,
          result.body,
        );
      }
      return result.body;
    },
  };
}

/**
 * Reports whether an rm response body describes a failure. The body is one
 * or more newline-separated JSON documents.
 */
function rmFailed(body: string): boolean {
  for (const line of body.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let doc: { error?: unknown; failed?: unknown };
    try {
      doc = JSON.parse(line);
    } catch {
      continue;
    }
    if (doc.error || (Array.isArray(doc.failed) && doc.failed.length > 0)) {
      return true;
    }
  }
  return false;
}

/** Error thrown when the exe.dev API reports a failed command. */
export class ExeAPIError extends Error {
  public readonly command: string;
  public readonly status: number;
  public readonly body: string;

  constructor(command: string, status: number, body: string) {
    super(`exe.dev API error (${status}): ${body.trim()}`);
    this.name = "ExeAPIError";
    this.command = command;
    this.status = status;
    this.body = body;
  }
}
