import { describe, it, expect } from "vitest";
import {
  unpackPacker, findPlayerFile, parseServerTokens, decodeEmbedToken,
  megaplayDecrypt, megaplayKeysFromJs, stripSeasonSuffix, titleOverlap, isNineAnimeUrl,
  resolveNineAnimeWatch, type FetchText,
} from "./nineAnime";

// Real MegaPlay `enc` captured 2026-11-26 (decrypts to {"file":".../master.m3u8"}).
const ENC = "wdeBruh3qqn_i5wUNnyaPcXqidp1UWP84FfPHzGyKXA2hDZBfMCmZ4FLvs7_pQuH549Eptax8UOjAJyRIZfrRkKC-XO8FCQmJzOmUm-BNc8T87ZGZ6f414bsbqguiuVk8VKvWekeFscSCVG_6bWo1XLdtLkmMDIFJ3BPvxGJ8VE";

const PACKED = String.raw`<script>eval(function(p,a,c,k,e,d){e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];e=function(){return'\\w+'};c=1};while(c--){if(k[c]){p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c])}}return p}('1.2({3:[{4:[{\'5\':\'6\',\'7\':\'8\\/9\',\'a\':\'b://c.d.e/f/g.h-i\'}],"j":[{"k":"\\/l\\/m.n","o":"p"}]}]});',26,26,'|player|setup|playlist|sources|label|360p|type|video|mp4|file|https|dry|workers|dev|media|v1|4uNQ|key|tracks|kind|uploads|subs|vtt|default|true'.split('|'),0,{}))</script>`;

describe("nineAnime", () => {
  it("unpacks the packed JWPlayer page and finds the file", () => {
    expect(findPlayerFile(unpackPacker(PACKED) || "")).toBe("https://dry.workers.dev/media/v1.4uNQ-key");
  });
  it("skips subtitle/thumbnail files", () => {
    expect(findPlayerFile(String.raw`tracks:[{"file":"https://x/a.vtt"}],sources:[{'file':'https://y/v.mp4'}]`)).toBe("https://y/v.mp4");
  });
  it("parses server buttons and embed tokens", () => {
    const tok = btoa('{"u":"https:\\/\\/secure.9anime.cx\\/videos\\/abc","e":1795720970,"s":"x"}').replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const t = parseServerTokens(`<button class="server-btn active "\n data-token="${tok}">HD-1</button><button class="server-btn server-btn-locked" data-token="L">VIP</button><button class="x" data-token="n">`);
    expect(t.map((x) => x[0])).toEqual([false, true]);
    expect(decodeEmbedToken(t[0][1])).toEqual({ url: "https://secure.9anime.cx/videos/abc", exp: 1795720970 });
  });
  it("decrypts a real MegaPlay payload and rejects a wrong key", async () => {
    expect(await megaplayDecrypt(ENC)).toMatch(/\/master\.m3u8$/);
    await expect(megaplayDecrypt(ENC, "wrong-key")).rejects.toBeTruthy();
  });
  it("reads rotated keys from the player script", () => {
    expect(megaplayKeysFromJs('const SOURCE_ENC_KEY="abc",SOURCE_ENC_IV="def",X=1')).toEqual(["abc", "def"]);
  });
  it("title helpers", () => {
    expect(stripSeasonSuffix("that time i got reincarnated as a slime season 4")).toBe("that time i got reincarnated as a slime");
    expect(titleOverlap("one piece", "One Piece Film Red")).toBeLessThan(0.6);
    expect(isNineAnimeUrl("https://9anime.co.ke/watch/x-episode-1")).toBe(true);
  });
  it("resolves a watch page through the MP4 path with an injected fetch", async () => {
    const tok = btoa('{"u":"https://secure.9anime.cx/videos/abc","e":0,"s":"x"}').replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const ft: FetchText = async (url) =>
      url.includes("/watch/")
        ? { ok: true, body: `<button class="server-btn" data-token="${tok}">HD-1</button>`, url }
        : { ok: true, body: PACKED, url };
    const r = await resolveNineAnimeWatch("https://9anime.co.ke/watch/black-clover-season-2-episode-9", ft);
    expect(r.file).toBe("https://dry.workers.dev/media/v1.4uNQ-key");
    expect(r.title).toBe("Black Clover Season 2 Episode 9");
    expect(r.referer).toBeUndefined();
  });
});
