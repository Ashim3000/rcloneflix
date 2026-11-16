import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useToastStore } from "../store/toastStore";

export type CastDevice = {
  id: string;
  name: string;
  model: string;
  ip: string;
  port: number;
};

export type CastStatus = {
  connected: boolean;
  device_name?: string;
  device_ip?: string;
  player_state: "IDLE" | "PLAYING" | "PAUSED" | "BUFFERING" | string;
  current_time: number;
  duration: number;
  volume: number;
  title?: string;
};

export type CastMediaParams = {
  streamUrl: string;
  title: string;
  contentType?: string;
  posterUrl?: string;
  currentTime?: number;
};

export async function discoverCastDevices(): Promise<CastDevice[]> {
  return invoke<CastDevice[]>("discover_cast_devices");
}

export async function connectCastDevice(
  ip: string,
  port?: number,
  name?: string
): Promise<CastStatus> {
  return invoke<CastStatus>("connect_cast_device", { ip, port, name });
}

export async function disconnectCastDevice(): Promise<void> {
  return invoke<void>("disconnect_cast_device");
}

export async function castLoadMedia(params: CastMediaParams): Promise<CastStatus> {
  return invoke<CastStatus>("cast_load_media", {
    req: {
      stream_url: params.streamUrl,
      title: params.title,
      content_type: params.contentType,
      poster_url: params.posterUrl,
      current_time: params.currentTime,
    },
  });
}

export async function castControl(
  action: "play" | "pause" | "stop" | "seek" | "volume",
  value?: number
): Promise<void> {
  return invoke<void>("cast_control", { action, value });
}

export async function getCastStatus(): Promise<CastStatus> {
  return invoke<CastStatus>("get_cast_status");
}

interface CastStore {
  devices: CastDevice[];
  selectedDevice: CastDevice | null;
  status: CastStatus;
  isScanning: boolean;
  scanDevices: () => Promise<void>;
  addManualDevice: (ip: string, name?: string) => Promise<void>;
  connect: (device: CastDevice) => Promise<void>;
  disconnect: () => Promise<void>;
  castMedia: (params: CastMediaParams) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  seek: (time: number) => Promise<void>;
  stop: () => Promise<void>;
  setVolume: (level: number) => Promise<void>;
  refreshStatus: () => Promise<void>;
}

export const useCastStore = create<CastStore>()(
  persist(
    (set, get) => ({
      devices: [],
      selectedDevice: null,
      status: {
        connected: false,
        player_state: "IDLE",
        current_time: 0,
        duration: 0,
        volume: 1,
      },
      isScanning: false,

      scanDevices: async () => {
        set({ isScanning: true });
        try {
          const list = await discoverCastDevices();
          const existing = get().devices;
          // Merge keeping any custom manual devices
          const merged = [...list];
          for (const d of existing) {
            if (!merged.some((m) => m.ip === d.ip && m.port === d.port)) {
              merged.push(d);
            }
          }
          set({ devices: merged, isScanning: false });
        } catch (e) {
          console.warn("Cast discovery error:", e);
          set({ isScanning: false });
        }
      },

      addManualDevice: async (ip: string, name?: string) => {
        const cleanIp = ip.trim();
        if (!cleanIp) return;
        const newDev: CastDevice = {
          id: `${cleanIp}:8009`,
          name: name?.trim() || `Chromecast (${cleanIp})`,
          model: "Google Cast Device",
          ip: cleanIp,
          port: 8009,
        };
        const current = get().devices;
        if (!current.some((d) => d.ip === cleanIp)) {
          set({ devices: [newDev, ...current] });
        }
        await get().connect(newDev);
      },

      connect: async (device: CastDevice) => {
        try {
          useToastStore.getState().addToast(`Connecting to ${device.name}...`, "info");
          const res = await connectCastDevice(device.ip, device.port, device.name);
          set({ selectedDevice: device, status: res });
          useToastStore.getState().addToast(`Connected to ${device.name}!`, "success");
        } catch (err: any) {
          useToastStore.getState().addToast(`Cast connection failed: ${err}`, "error");
          throw err;
        }
      },

      disconnect: async () => {
        try {
          await disconnectCastDevice();
          set({
            selectedDevice: null,
            status: {
              connected: false,
              player_state: "IDLE",
              current_time: 0,
              duration: 0,
              volume: 1,
            },
          });
          useToastStore.getState().addToast("Disconnected from Cast device", "info");
        } catch (err) {
          console.warn("Cast disconnect error:", err);
        }
      },

      castMedia: async (params: CastMediaParams) => {
        const dev = get().selectedDevice;
        if (!dev) {
          throw new Error("No Cast device connected");
        }
        useToastStore.getState().addToast(`Casting "${params.title}" to ${dev.name}...`, "info");
        const res = await castLoadMedia(params);
        set({ status: res });
      },

      play: async () => {
        await castControl("play");
        set((s) => ({ status: { ...s.status, player_state: "PLAYING" } }));
      },

      pause: async () => {
        await castControl("pause");
        set((s) => ({ status: { ...s.status, player_state: "PAUSED" } }));
      },

      seek: async (time: number) => {
        await castControl("seek", time);
        set((s) => ({ status: { ...s.status, current_time: time } }));
      },

      stop: async () => {
        await castControl("stop");
        set((s) => ({ status: { ...s.status, player_state: "IDLE", title: undefined } }));
      },

      setVolume: async (level: number) => {
        await castControl("volume", level);
        set((s) => ({ status: { ...s.status, volume: level } }));
      },

      refreshStatus: async () => {
        if (!get().selectedDevice) return;
        try {
          const res = await getCastStatus();
          set({ status: res });
        } catch (e) {
          console.warn("Failed to get cast status:", e);
        }
      },
    }),
    {
      name: "rcloneflix-cast-state",
      partialize: (state) => ({
        devices: state.devices,
      }),
    }
  )
);

// Status poller while active casting
let castPoller: any = null;

export function initCastPoller() {
  if (castPoller) return;
  castPoller = setInterval(() => {
    const store = useCastStore.getState();
    if (store.status.connected) {
      store.refreshStatus();
    }
  }, 3000);
}
