import { invoke } from "@tauri-apps/api/core";

export interface DlnaStatus {
  running: boolean;
  remote: string;
  path: string;
  port: number;
  friendly_name: string;
  error?: string | null;
}

export interface TailscaleStatusResult {
  installed: boolean;
  running: boolean;
  backend_state: string;
  auth_url?: string | null;
  dns_name?: string | null;
  ip?: string | null;
}

export async function startDlnaServer(
  configPath: string,
  remote: string,
  path: string,
  port?: number,
  friendlyName?: string
): Promise<DlnaStatus> {
  return invoke<DlnaStatus>("start_dlna_server", {
    configPath,
    remote,
    path,
    port: port || null,
    friendlyName: friendlyName || null,
  });
}

export async function stopDlnaServer(): Promise<DlnaStatus> {
  return invoke<DlnaStatus>("stop_dlna_server");
}

export async function getDlnaStatus(): Promise<DlnaStatus> {
  return invoke<DlnaStatus>("get_dlna_status");
}

export async function getTailscaleStatus(): Promise<TailscaleStatusResult> {
  return invoke<TailscaleStatusResult>("get_tailscale_status");
}

export interface TailscaleRoute {
  port: number;
  target: string;
  is_funnel: boolean;
  url: string;
}

export interface TailscaleRoutesResult {
  routes: TailscaleRoute[];
  dns_name?: string | null;
}

export async function getTailscaleRoutes(): Promise<TailscaleRoutesResult> {
  return invoke<TailscaleRoutesResult>("get_tailscale_routes");
}

export async function setTailscaleServe(listenPort: number = 8443, targetPort: number = 8551): Promise<string> {
  return invoke<string>("set_tailscale_serve", { listenPort, targetPort });
}

export async function setTailscaleFunnel(listenPort: number = 8443, targetPort: number = 8551): Promise<string> {
  return invoke<string>("set_tailscale_funnel", { listenPort, targetPort });
}

export async function resetTailscaleRoutes(): Promise<void> {
  return invoke<void>("reset_tailscale_routes");
}

