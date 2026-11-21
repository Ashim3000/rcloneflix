import { httpFetch } from "./httpFetch";

export type StashBoxProvider = {
  id: string;
  name: string;
  endpoint: string;
  apiKey: string;
  enabled: boolean;
};

export type StashSceneMatch = {
  id: string;
  title: string;
  date?: string;
  details?: string;
  posterUrl?: string;
  studio?: string;
  performers: string[];
  tags: string[];
  source: "stashbox" | "theporndb";
};

export type AdultSceneFragment = {
  studio?: string;
  date?: string;
  performers: string[];
  title: string;
};

export function parseAdultSceneFragment(filename: string): AdultSceneFragment {
  const clean = filename.replace(/\.[a-z0-9]{2,4}$/i, "");
  const m = clean.match(/^(.+?)[. _-]+(\d{2,4})[.\-_](\d{2})[.\-_](\d{2})[. _-]+(.+?)(?:[. _-]+(?:XXX|1080p|2160p|720p|4K|MP4|WEBRip).*)?$/i);
  if (m) {
    const rawYear = m[2].length === 2 ? `20${m[2]}` : m[2];
    const date = `${rawYear}-${m[3]}-${m[4]}`;
    const studio = m[1].replace(/[._]+/g, " ").trim();
    const tail = m[5].replace(/[._]+/g, " ").trim();
    return { studio, date, performers: [], title: tail || clean };
  }
  return {
    performers: [],
    title: clean.replace(/[._]+/g, " ").replace(/\b(?:XXX|1080p|2160p|720p|4K)\b/gi, "").trim(),
  };
}

function mapStashScene(s: any): StashSceneMatch {
  return {
    id: String(s.id),
    title: s.title || "Untitled Scene",
    date: s.date || undefined,
    details: s.details || undefined,
    posterUrl: s.images?.[0]?.url || undefined,
    studio: s.studio?.name || undefined,
    performers: (s.performers || []).map((p: any) => p?.performer?.name).filter(Boolean),
    tags: (s.tags || []).map((t: any) => t?.name).filter(Boolean),
    source: "stashbox",
  };
}

export async function testStashBoxConnection(provider: StashBoxProvider): Promise<{ ok: boolean; message: string }> {
  const res = await httpFetch(provider.endpoint.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey.trim() ? { ApiKey: provider.apiKey.trim() } : {}),
    },
    body: JSON.stringify({ query: "{ version { version } }" }),
  });
  if (!res.ok) {
    return { ok: false, message: `HTTP ${res.status} from ${provider.endpoint}` };
  }
  const json = await res.json();
  if (json.errors?.length) {
    return { ok: false, message: json.errors[0].message || "GraphQL error" };
  }
  return { ok: true, message: `Connected to ${provider.name} (v${json.data?.version?.version || "ok"})` };
}

export async function findScenesByFingerprint(
  provider: StashBoxProvider,
  fp: { hash: string; algorithm: "OSHASH" | "PHASH"; duration?: number }
): Promise<StashSceneMatch[]> {
  const query = `
    query FindScenesBySceneFingerprints($fingerprints: [[FingerprintQueryInput!]!]!) {
      findScenesBySceneFingerprints(fingerprints: $fingerprints) {
        id title date details
        urls { url }
        images { url }
        studio { name }
        performers { performer { name } }
        tags { name }
      }
    }
  `;
  const input: Record<string, any> = { hash: fp.hash, algorithm: fp.algorithm };
  if (fp.duration && fp.duration > 0) input.duration = Math.round(fp.duration);

  const res = await httpFetch(provider.endpoint.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey.trim() ? { ApiKey: provider.apiKey.trim() } : {}),
    },
    body: JSON.stringify({ query, variables: { fingerprints: [[input]] } }),
  });
  if (!res.ok) throw new Error(`Stash-Box HTTP ${res.status}`);
  const json = await res.json();
  const list = json?.data?.findScenesBySceneFingerprints?.[0] || [];
  return Array.isArray(list) ? list.map(mapStashScene) : [];
}

export async function searchScenesByFragment(
  provider: StashBoxProvider | null,
  fragment: AdultSceneFragment,
  thePornDbApiKey?: string
): Promise<StashSceneMatch[]> {
  const out: StashSceneMatch[] = [];
  if (provider?.enabled && provider.endpoint) {
    try {
      const qStr = [fragment.studio, fragment.title].filter(Boolean).join(" ").trim();
      const query = `
        query QueryScenes($input: SceneQueryInput!) {
          queryScenes(input: $input) {
            scenes {
              id title date details
              images { url }
              studio { name }
              performers { performer { name } }
              tags { name }
            }
          }
        }
      `;
      const input: Record<string, any> = { q: qStr, per_page: 10 };
      if (fragment.date) input.date = { value: fragment.date, modifier: "EQUALS" };
      const res = await httpFetch(provider.endpoint.trim(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey.trim() ? { ApiKey: provider.apiKey.trim() } : {}),
        },
        body: JSON.stringify({ query, variables: { input } }),
      });
      if (res.ok) {
        const json = await res.json();
        const scenes = json?.data?.queryScenes?.scenes || [];
        scenes.forEach((s: any) => out.push(mapStashScene(s)));
      }
    } catch {}
  }

  if (thePornDbApiKey?.trim()) {
    try {
      const qStr = [fragment.studio, fragment.date, fragment.title].filter(Boolean).join(" ").trim();
      const res = await httpFetch(`https://api.theporndb.net/scenes?q=${encodeURIComponent(qStr)}`, {
        headers: { Authorization: `Bearer ${thePornDbApiKey.trim()}`, Accept: "application/json" },
      });
      if (res.ok) {
        const json = await res.json();
        for (const s of json?.data || []) {
          out.push({
            id: String(s.id),
            title: s.title || "Untitled Scene",
            date: s.date || undefined,
            details: s.description || undefined,
            posterUrl: s.posters?.large || s.poster || s.image || undefined,
            studio: s.site?.name || undefined,
            performers: (s.performers || []).map((p: any) => p?.name).filter(Boolean),
            tags: (s.tags || []).map((t: any) => t?.name).filter(Boolean),
            source: "theporndb",
          });
        }
      }
    } catch {}
  }
  return out;
}
