/** A VM as returned by `ls --json`. */
export interface VM {
  vm_name: string;
  ssh_dest: string;
  https_url: string;
  status: string;
  region: string;
  region_display: string;
}

export interface VMListResponse {
  vms: VM[];
}

export interface WhoamiResponse {
  email: string;
  user_id: string;
}

export interface StatResponse {
  vm_name: string;
  status: string;
  region: string;
  region_display: string;
  cpus: number;
  memory_mb: number;
  disk_gb: number;
  ssh_dest: string;
  https_url: string;
}

/** The response to `new`. Only the fields the SDK relies on are listed. */
export interface NewResponse {
  vm_name: string;
}
