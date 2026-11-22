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
  fp: { hash: string; algorithm: "OSHASH" | "PHASH" }
): Promise<StashSceneMatch[]> {
  const cleanHash = fp.hash.trim().toLowerCase();
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
  // Stash-Box FingerprintQueryInput only accepts { hash, algorithm } — never pass duration here.
  const input = { hash: cleanHash, algorithm: fp.algorithm };

  const res = await httpFetch(provider.endpoint.trim(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(provider.apiKey.trim() ? { ApiKey: provider.apiKey.trim() } : {}),
    },
    body: JSON.stringify({ query, variables: { fingerprints: [[input]] } }),
  });
  if (!res.ok) throw new Error(`${provider.name || "Stash-Box"} HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors[0].message || `${provider.name || "Stash-Box"} GraphQL error`);
  }
  const list = json?.data?.findScenesBySceneFingerprints?.[0] || [];
  return Array.isArray(list) ? list.map(mapStashScene) : [];
}

function mapThePornDbScene(s: any): StashSceneMatch {
  return {
    id: String(s.id ?? s._id ?? ""),
    title: s.title || "Untitled Scene",
    date: s.date || undefined,
    details: s.description || s.details || undefined,
    posterUrl: s.posters?.large || s.poster || s.image || s.background?.large || undefined,
    studio: s.site?.name || undefined,
    performers: (s.performers || []).map((p: any) => p?.name || p?.parent?.name).filter(Boolean),
    tags: (s.tags || []).map((t: any) => t?.name).filter(Boolean),
    source: "theporndb",
  };
}

export async function findThePornDbScenesByHash(
  hash: string,
  thePornDbApiKey: string,
  algorithm: "OSHASH" | "PHASH"
): Promise<StashSceneMatch[]> {
  const key = thePornDbApiKey.trim();
  const cleanHash = hash.trim().toLowerCase();
  if (!key || !cleanHash) return [];

  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: "application/json",
  };

  const res = await httpFetch(
    `https://api.theporndb.net/scenes?hash=${encodeURIComponent(cleanHash)}&hashType=${encodeURIComponent(algorithm)}`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`ThePornDB HTTP ${res.status}`);
  }
  const json = await res.json();
  const rawList = Array.isArray(json?.data) ? json.data : json?.data ? [json.data] : [];
  if (rawList.length > 0) {
    return rawList.map(mapThePornDbScene).filter((m: StashSceneMatch) => Boolean(m.id));
  }

  // Fallback path-based hash lookup (/scenes/hash/{hash})
  const fallbackRes = await httpFetch(
    `https://api.theporndb.net/scenes/hash/${encodeURIComponent(cleanHash)}`,
    { headers }
  );
  if (!fallbackRes.ok) return [];
  const fbJson = await fallbackRes.json();
  const fbList = Array.isArray(fbJson?.data) ? fbJson.data : fbJson?.data ? [fbJson.data] : [];
  return fbList.map(mapThePornDbScene).filter((m: StashSceneMatch) => Boolean(m.id));
}

export type IdentifyByHashResult = {
  matches: StashSceneMatch[];
  queriedProviders: string[];
  errors: string[];
};

export async function identifyByHash(params: {
  hash: string;
  algorithm: "OSHASH" | "PHASH";
  provider: StashBoxProvider | null;
  thePornDbApiKey?: string;
}): Promise<IdentifyByHashResult> {
  const { hash, algorithm, provider, thePornDbApiKey } = params;
  const queriedProviders: string[] = [];
  const errors: string[] = [];
  const tasks: Array<Promise<StashSceneMatch[]>> = [];

  if (provider?.enabled && provider.endpoint.trim()) {
    const label = provider.name || "Stash-Box";
    queriedProviders.push(label);
    tasks.push(
      findScenesByFingerprint(provider, { hash, algorithm }).catch((err: any) => {
        errors.push(`${label}: ${err?.message || String(err)}`);
        return [];
      })
    );
  }

  if (thePornDbApiKey?.trim()) {
    queriedProviders.push("ThePornDB");
    tasks.push(
      findThePornDbScenesByHash(hash, thePornDbApiKey, algorithm).catch((err: any) => {
        errors.push(`ThePornDB: ${err?.message || String(err)}`);
        return [];
      })
    );
  }

  const results = await Promise.all(tasks);
  const seen = new Set<string>();
  const matches: StashSceneMatch[] = [];
  for (const group of results) {
    for (const m of group) {
      const k = `${m.source}:${m.id}`;
      if (!seen.has(k)) {
        seen.add(k);
        matches.push(m);
      }
    }
  }

  return { matches, queriedProviders, errors };
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
