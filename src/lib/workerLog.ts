/**
 * Kaggle's kernels/output `log` field is usually a JSON ARRAY serialised as a string:
 *   [{"stream_name":"stdout","time":1.2,"data":"line\n"}, ...]
 * so quotes inside worker output arrive as \" . GitHub Actions logs are plain text.
 * normalizeWorkerLog() returns plain stdout/stderr text in both cases.
 */
export function normalizeWorkerLog(raw: string | null | undefined): string {
  if (!raw) return "";
  const t = raw.trimStart();
  if (!t.startsWith("[") && !t.startsWith("{")) return raw;

  try {
    const parsed = JSON.parse(raw);
    const events: any[] = Array.isArray(parsed) ? parsed : [parsed];
    const text = events
      .map((ev) => (typeof ev?.data === "string" ? ev.data : ""))
      .filter(Boolean)
      .join(""); // chunks are concatenated verbatim: Kaggle may split one stdout line across events
    if (text) return text;
  } catch {
    // truncated / malformed array: pull each "data":"..." string out individually
    const out: string[] = [];
    const re = /"data"\s*:\s*("(?:[^"\\]|\\.)*")/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      try {
        const d = JSON.parse(m[1]) as string;
        out.push(d);
      } catch {
        /* skip bad fragment */
      }
    }
    if (out.length) return out.join("");
  }
  return raw;
}

export type StreamtapeOffloadResult = {
  name: string;
  size?: number;
  linkid?: string;
  shareUrl: string;
  remotePath?: string;
};

export function parseStreamtapeOffloadResults(log: string): StreamtapeOffloadResult[] {
  const out: StreamtapeOffloadResult[] = [];
  for (const line of normalizeWorkerLog(log).split(/\r?\n/)) {
    const i = line.indexOf("RCLONEFLIX_STREAMTAPE_OFFLOAD_RESULT:");
    if (i === -1) continue;
    try {
      const o = JSON.parse(line.slice(i + "RCLONEFLIX_STREAMTAPE_OFFLOAD_RESULT:".length).trim());
      if (o && typeof o.shareUrl === "string") out.push(o);
    } catch {
      /* ignore */
    }
  }
  return out;
}
