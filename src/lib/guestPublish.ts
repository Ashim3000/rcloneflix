import { useAppStore } from "../store/appStore";
import { log } from "./log";

const KEY = "rcloneflix_auto_publish_guest_passes";
const DEBOUNCE_MS = 45_000;
const MAX_WAIT_MS = 10 * 60_000;

export function isAutoPublishEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}
export function setAutoPublishEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let firstPendingAt = 0;

function hasPublishablePasses(): boolean {
  return (useAppStore.getState().issuedPasses || []).some(
    (p) => p.catalogKey && p.status !== "revoked" && p.status !== "expired"
  );
}

/** Cheap: just (re)arms a trailing debounce. Content-hash gating makes spurious calls free. */
export function schedulePassPublish(): void {
  if (!isAutoPublishEnabled() || !hasPublishablePasses()) return;
  const now = Date.now();
  if (!firstPendingAt) firstPendingAt = now;
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, firstPendingAt + MAX_WAIT_MS - now));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    firstPendingAt = 0;
    void runPublish();
  }, wait);
}

async function runPublish(): Promise<void> {
  if (useAppStore.getState().scanState.status === "scanning") {
    schedulePassPublish(); // try again after the scan settles
    return;
  }
  try {
    const { publishUpdatesToIssuedPasses } = await import("./accessPass");
    const r = await publishUpdatesToIssuedPasses();
    if (r.updated || r.failed.length) {
      log.info("access-pass", `auto-publish: ${r.updated} updated, ${r.unchanged} unchanged, ${r.failed.length} failed`);
    }
  } catch (e) {
    log.warn("access-pass", `auto-publish failed: ${e}`);
  }
}

/** Watches library content / curator picks / library list; returns an unsubscribe. */
export function installPublishWatcher(): () => void {
  const unsub = useAppStore.subscribe((state, prev) => {
    if (
      state.mediaItems !== prev.mediaItems ||
      state.adminWeeklyRecommendations !== prev.adminWeeklyRecommendations ||
      state.libraries !== prev.libraries
    ) {
      schedulePassPublish();
    }
  });
  schedulePassPublish(); // catch-up for edits made before the app was last closed (hash gate makes it a no-op if nothing changed)
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
    timer = null;
    firstPendingAt = 0;
  };
}
