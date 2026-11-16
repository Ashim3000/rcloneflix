import { describe, it, expect } from "vitest";
import {
  parseRcloneIni,
  findRemoteDependencies,
  extractScopedRcloneConfig,
  sanitizeScopedRcloneConfig,
  rewriteRemotePath,
  isWritableCloudStorageRemote,
  getOrderedWritableCloudRemotes,
  findWritableCloudStorageRemote,
  formatRemoteDisplayName,
  durationToMs,
  formatDuration,
  uint8ArrayToBase64,
  base64ToUint8Array,
} from "./accessPass";

describe("accessPass", () => {
  const SAMPLE_RCLONE_CONF = `
[drivemine]
type = opendrive
username = ashim
password = secret_hash

[odrivecrypt]
type = crypt
remote = drivemine:encrypted_vault
password = crypt_pass_1
password2 = crypt_pass_2

[workdrive]
type = drive
scope = drive
token = {"access_token":"super_secret_work_token"}

[workcrypt]
type = crypt
remote = workdrive:work_vault
password = work_pass

[alias_to_crypt]
type = alias
remote = odrivecrypt:
`;

  it("parses rclone INI correctly", () => {
    const sections = parseRcloneIni(SAMPLE_RCLONE_CONF);
    expect(sections.has("drivemine")).toBe(true);
    expect(sections.has("odrivecrypt")).toBe(true);
    expect(sections.has("workdrive")).toBe(true);
    expect(sections.get("drivemine")?.get("type")).toBe("opendrive");
    expect(sections.get("odrivecrypt")?.get("remote")).toBe("drivemine:encrypted_vault");
  });

  it("finds recursive remote dependencies correctly", () => {
    const sections = parseRcloneIni(SAMPLE_RCLONE_CONF);

    const odriveDeps = findRemoteDependencies("odrivecrypt", sections);
    expect(Array.from(odriveDeps)).toContain("odrivecrypt");
    expect(Array.from(odriveDeps)).toContain("drivemine");
    expect(Array.from(odriveDeps)).not.toContain("workdrive");

    const aliasDeps = findRemoteDependencies("alias_to_crypt", sections);
    expect(Array.from(aliasDeps)).toContain("alias_to_crypt");
    expect(Array.from(aliasDeps)).toContain("odrivecrypt");
    expect(Array.from(aliasDeps)).toContain("drivemine");
    expect(Array.from(aliasDeps)).not.toContain("workdrive");
  });

  it("extracts scoped config and strips unneeded private remotes", () => {
    const { scopedConfig, remoteMapping } = extractScopedRcloneConfig(
      SAMPLE_RCLONE_CONF,
      ["odrivecrypt"]
    );

    // Only drivemine and odrivecrypt should be present, renamed anonymously with shared_cloud_N
    expect(remoteMapping["odrivecrypt"]).toBe("shared_cloud_1");
    expect(remoteMapping["drivemine"]).toBe("shared_cloud_2");

    expect(formatRemoteDisplayName(remoteMapping["odrivecrypt"])).toBe("Cloud Remote 1");
    expect(formatRemoteDisplayName(remoteMapping["drivemine"])).toBe("Cloud Remote 2");

    expect(scopedConfig).toContain("[shared_cloud_1]");
    expect(scopedConfig).toContain("[shared_cloud_2]");
    expect(scopedConfig).toContain("remote = shared_cloud_2:encrypted_vault");

    // Private work drive must NEVER appear in the scoped config
    expect(scopedConfig).not.toContain("workdrive");
    expect(scopedConfig).not.toContain("super_secret_work_token");
    expect(scopedConfig).not.toContain("workcrypt");
  });

  it("rewrites remote paths accurately", () => {
    const mapping = {
      odrivecrypt: "shared_odrivecrypt",
      drivemine: "shared_drivemine",
    };

    expect(rewriteRemotePath("odrivecrypt:Movies", mapping)).toBe("shared_odrivecrypt:Movies");
    expect(rewriteRemotePath("odrivecrypt:TV Shows/Season 1", mapping)).toBe("shared_odrivecrypt:TV Shows/Season 1");
    expect(rewriteRemotePath("drivemine:Photos", mapping)).toBe("shared_drivemine:Photos");
  });

  it("calculates durations accurately", () => {
    expect(durationToMs("1d")).toBe(24 * 60 * 60 * 1000);
    expect(durationToMs("7d")).toBe(7 * 24 * 60 * 60 * 1000);
    expect(durationToMs("60d")).toBe(60 * 24 * 60 * 60 * 1000);
    expect(durationToMs("lifetime")).toBeNull();

    expect(formatDuration("1d")).toBe("1 Day");
    expect(formatDuration("7d")).toBe("1 Week");
    expect(formatDuration("60d")).toBe("60 Days");
    expect(formatDuration("lifetime")).toBe("Lifetime (Never Expires)");
  });

  it("never rewrites backend type when remote name matches type name", () => {
    const CONF_WITH_MATCHING_NAME = `
[opendrive]
type = opendrive
username = test@example.com
password = pass123

[odrivecrypt]
type = crypt
remote = opendrive:vault
password = secret
`;
    const { scopedConfig } = extractScopedRcloneConfig(CONF_WITH_MATCHING_NAME, ["odrivecrypt"]);

    expect(scopedConfig).toContain("[shared_cloud_1]");
    expect(scopedConfig).toContain("[shared_cloud_2]");
    expect(scopedConfig).toContain("remote = shared_cloud_2:vault");
    // type must remain 'opendrive', NOT 'shared_opendrive' or 'shared_cloud_2'
    expect(scopedConfig).toContain("type = opendrive");
    expect(scopedConfig).not.toContain("type = shared_opendrive");
    expect(scopedConfig).not.toContain("type = shared_cloud_2");
  });

  it("sanitizes any existing type = shared_... in scoped config", () => {
    const BAD_CONFIG = `
[shared_odrivecrypt]
type = crypt
remote = shared_opendrive:vault

[shared_opendrive]
type = shared_opendrive
username = test
`;
    const sanitized = sanitizeScopedRcloneConfig(BAD_CONFIG);
    expect(sanitized).toContain("type = opendrive");
    expect(sanitized).not.toContain("type = shared_opendrive");
    expect(sanitized).toContain("remote = shared_opendrive:vault");
  });

  it("encodes and decodes pass string round-trip accurately", () => {
    const originalText = "RFLIX_ADMIN_PASS_TEST_PAYLOAD_12345";
    const bytes = new TextEncoder().encode(originalText);
    const base64 = uint8ArrayToBase64(bytes);
    expect(typeof base64).toBe("string");
    expect(base64.length).toBeGreaterThan(0);

    const decodedBytes = base64ToUint8Array(base64);
    const decodedText = new TextDecoder().decode(decodedBytes);
    expect(decodedText).toBe(originalText);
  });

  it("accurately detects writable cloud remotes and filters out cyberlockers / loopback mounts", () => {
    const COMPLEX_CONF = `
[streamtape]
type = webdav
url = http://127.0.0.1:5244/dav/streamtape
vendor = other

[telegram-drive]
type = webdav
url = http://127.0.0.1:8551/dav/telegram
vendor = other

[realdebrid]
type = webdav
url = https://dav.real-debrid.com
vendor = other

[opendrive]
type = opendrive
username = user@domain.com
password = opendrive_pass

[odrivecrypt]
type = crypt
remote = opendrive:vault
password = crypt_pass

[drivemine]
type = drive
scope = drive
token = {"access_token":"token"}

[gcrypt]
type = crypt
remote = drivemine:media
password = gpass
`;

    // Loopback & cyberlockers should return false
    expect(isWritableCloudStorageRemote("streamtape", COMPLEX_CONF)).toBe(false);
    expect(isWritableCloudStorageRemote("telegram-drive", COMPLEX_CONF)).toBe(false);
    expect(isWritableCloudStorageRemote("realdebrid", COMPLEX_CONF)).toBe(false);

    // True cloud backends and their crypt wrappers should return true
    expect(isWritableCloudStorageRemote("opendrive", COMPLEX_CONF)).toBe(true);
    expect(isWritableCloudStorageRemote("odrivecrypt", COMPLEX_CONF)).toBe(true);
    expect(isWritableCloudStorageRemote("drivemine", COMPLEX_CONF)).toBe(true);
    expect(isWritableCloudStorageRemote("gcrypt", COMPLEX_CONF)).toBe(true);

    // Ordered selection prioritizes valid candidates from preferred list
    const candidates = getOrderedWritableCloudRemotes(
      ["streamtape", "odrivecrypt", "gcrypt"],
      COMPLEX_CONF
    );
    expect(candidates[0]).toBe("odrivecrypt");
    expect(candidates).toContain("gcrypt");
    expect(candidates).not.toContain("streamtape");

    const chosen = findWritableCloudStorageRemote(
      ["streamtape", "telegram-drive", "odrivecrypt"],
      COMPLEX_CONF
    );
    expect(chosen).toBe("odrivecrypt");
  });

  it("leaves https, http, and local filesystem paths untouched in rewriteRemotePath", () => {
    const mapping = {
      odrivecrypt: "shared_odrivecrypt",
    };

    expect(rewriteRemotePath("https://streamtape.com/v/abcd123", mapping)).toBe("https://streamtape.com/v/abcd123");
    expect(rewriteRemotePath("http://127.0.0.1:5244/d/foo.mp4", mapping)).toBe("http://127.0.0.1:5244/d/foo.mp4");
    expect(rewriteRemotePath("/mnt/chromeos/MyFiles/Downloads/Music/song.mp3", mapping)).toBe("/mnt/chromeos/MyFiles/Downloads/Music/song.mp3");
    expect(rewriteRemotePath("C:\\Users\\User\\Music\\song.mp3", mapping)).toBe("C:\\Users\\User\\Music\\song.mp3");
    expect(rewriteRemotePath("odrivecrypt:Music/song.mp3", mapping)).toBe("shared_odrivecrypt:Music/song.mp3");
  });
});
