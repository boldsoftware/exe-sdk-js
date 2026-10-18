/** A VM as returned by `ls --json`. */
export interface VM {
  vm_name: string;
  ssh_dest: string;
  https_url: string;
  status: string;
  region: string;
  region_display: string;
  /** Absent when the VM has no tags. */
  tags?: string[];
  /** The VM's comment, if it has one. */
  comment?: string;
  /** When the VM was created, in RFC 3339 format. */
  created_at?: string;
}

export interface VMListResponse {
  vms: VM[];
}

/** An SSH key as listed by `whoami`. */
export interface WhoamiSSHKey {
  name: string;
  public_key: string;
  fingerprint: string;
  /** Whether this is the key making the request. */
  current: boolean;
}

export interface WhoamiResponse {
  email: string;
  region: string;
  region_display: string;
  ssh_keys: WhoamiSSHKey[];
}

/** One sample of a VM's resource usage, as returned by `stat`. */
export interface StatPoint {
  timestamp: string;
  vm_name: string;
  cpu_cores: number;
  cpu_nominal: number;
  mem_used_bytes: number;
  mem_total_bytes: number;
  disk_size_gb: number;
  disk_used_gb: number;
  disk_logical_used_gb: number;
  fs_used_gb: number;
  fs_total_gb: number;
  fs_free_gb: number;
  fs_available_gb: number;
  network_tx_mbps: number;
  network_rx_mbps: number;
  io_read_mbps: number;
  io_write_mbps: number;
}

export interface StatResponse {
  name: string;
  status: string;
  /** The window the points cover, e.g. "24h". */
  range: string;
  /** Usage samples, or null if there are none yet (e.g. a new VM). */
  points: StatPoint[] | null;
}

/** The response to `new`. */
export interface NewResponse {
  vm_name: string;
  tags: string[];
  ssh_command: string;
  ssh_dest: string;
  ssh_host: string;
  ssh_user?: string;
  ssh_port: number;
  https_url: string;
  proxy_port: number;
  shelley_url?: string;
  vscode_url?: string;
  xterm_url?: string;
  pool_id?: string;
  standalone?: boolean;
  /** Set when the VM was created but a later setup step failed. */
  error?: string;
}

/** The response to `cp`. */
export interface CpResponse {
  /** The new VM's name. */
  name: string;
  /** The new VM is still booting. */
  state: "starting";
  /** The VM it is a copy of. */
  source: string;
  /** The new VM's SSH destination, like ssh_dest in `ls`. */
  ssh: string;
  ssh_host: string;
  ssh_user?: string;
  /** How long the copy took, in seconds. */
  elapsed: number;
  /** The pool the new VM is in, if any. */
  pool_id?: string;
  pool_name?: string;
  standalone?: boolean;
}

/** The response to `rm`. */
export interface RmResponse {
  deleted: string[];
  failed: string[];
}

/** The response to `restart`. */
export interface RestartResponse {
  status: "restarted";
  vm_name: string;
}

/** The response to `rename`. */
export interface RenameResponse {
  status: "renamed";
  old_name: string;
  new_name: string;
}

/**
 * Result types by command path. A command method resolves to the type listed
 * here for its path, or to unknown.
 */
export interface CommandResults {
  cp: CpResponse;
  ls: VMListResponse;
  new: NewResponse;
  rm: RmResponse;
  restart: RestartResponse;
  rename: RenameResponse;
  stat: StatResponse;
  whoami: WhoamiResponse;
}
