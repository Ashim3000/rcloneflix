/**
 * Trakt compatibility shim — RcloneFlix now standardizes on Simkl
 * for 100% free, no-VIP scrobbling and cloud discovery.
 */
import {
  simklScrobble,
  refreshSimklDiscovery,
  type SimklScrobbleAction,
} from "./simkl";
import type { MediaItem } from "../store/appStore";

export type TraktScrobbleAction = SimklScrobbleAction;

export async function traktScrobble(
  action: TraktScrobbleAction,
  item: MediaItem,
  progressPercent: number
): Promise<boolean> {
  return simklScrobble(action, item, progressPercent);
}

export async function refreshTraktDiscovery(force = false): Promise<boolean> {
  return refreshSimklDiscovery(force);
}
