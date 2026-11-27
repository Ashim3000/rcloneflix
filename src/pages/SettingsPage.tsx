import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Folder, Lock, RefreshCw, Key, Shield, AlertCircle, Play,
  Trash2, Plus, Edit2, X, Cloud, Eye, EyeOff, Save, Check, HardDrive, Share2, Compass,
  Zap, ExternalLink, Loader2, Radio, Tv, Wifi, Copy, Cast, Globe, Film, Server, CloudUpload, Send,
  BookOpen, Sparkles, Cpu, Palette, CheckCircle2, FileText,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { runAutoStreamtapeOffload } from "../lib/streamtapeOffload";
import { validateAndFetchStremioAddon } from "../lib/stremioAddonEngine";
import { signIntoDropmb } from "../lib/dropmbOffload";
import { runKeepAliveHealthCheck, getKeepAliveMetrics, type KeepAliveStats } from "../lib/cyberlockerKeepAlive";
import {
  startDlnaServer,
  stopDlnaServer,
  getDlnaStatus,
  getTailscaleStatus,
  getTailscaleRoutes,
  setTailscaleServe,
  setTailscaleFunnel,
  resetTailscaleRoutes,
  type DlnaStatus,
  type TailscaleStatusResult,
  type TailscaleRoute,
} from "../lib/dlna";
import { useCastStore, type CastDevice } from "../lib/cast";
import {
  useAppStore,
  isLocalPath,
  defaultRcloneSettings,
  type Library,
  type LibraryType,
  type RcloneRemote,
  type RcloneSettings,
  type GhaAccount,
  type KaggleAccount,
} from "../store/appStore";
import { useToastStore } from "../store/toastStore";
import { hashPin } from "../lib/pin";
import { getLogPath, readLogTail } from "../lib/log";
import { backupToRemote, restoreFromRemote, BACKUP_FILE } from "../lib/rcloneSync";
import { artworkCacheStats, clearArtworkCache } from "../lib/artwork";
import { RemoteBrowser } from "../components/common/RemoteBrowser";
import { VirtualRemoteCreateModal } from "../components/explorer/RcloneSuiteToolbar";
import { isAndroidRuntime, isValidSoftDeleteTrashDir } from "../lib/rcloneNative";
import { DiagnosticsQolCards } from "../components/settings/DiagnosticsQolCards";
import { pickLocalFolder, vaultPhotoCacheStats, clearVaultPhotoCache, rcloneCreateCryptRemote, rcloneCreateWebdavRemote, pickRcloneConfig, parseRcloneConfig, saveRcloneSettings } from "../lib/tauri";
import { ensureGitHubWorkerReady, DEFAULT_GHA_WORKER_REPO } from "../lib/githubWorkerProvisioner";
import { testStashBoxConnection, type StashBoxProvider } from "../lib/stashBox";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { scanLibrary } from "../lib/scanner";
import { CreateAccessPassModal } from "../components/accessPass/CreateAccessPassModal";
import { ImportAccessPassModal } from "../components/accessPass/ImportAccessPassModal";
import { removeSharedPass, revokeIssuedPass, formatDuration, syncIssuedPasses } from "../lib/accessPass";
import { refreshTraktDiscovery } from "../lib/trakt";
import { refreshSimklDiscovery, getSimklPin, pollSimklPin, DEFAULT_SIMKL_CLIENT_ID, type SimklPinResponse } from "../lib/simkl";
import { testEasynewsConnection } from "../lib/easynews";
import { testRealDebridKey, testPremiumizeKey, testOffcloudKey } from "../lib/debrid";
import {
  testKaggleConnection,
  loadKaggleCredentials,
  importKaggleJson,
  useCloudTranscodeStore,
} from "../lib/kaggleTranscode";
import {
  testStorytellerConnection,
  fetchStorytellerBooks,
  type StorytellerBook,
} from "../lib/storyteller";
import { useCloudAlignStore } from "../lib/kaggleAligner";
import { testGitHubActionsConnection } from "../lib/cloudWorkerRouter";
import {
  loadUdropConfig,
  saveUdropConfig,
  mountUdropWebdavRemote,
  getUdropAccountInfo,
  type UdropAccountInfo,
} from "../lib/udrop";
import {
  loadExternalServers,
  saveExternalServers,
  requestPlexPin,
  pollPlexPin,
  discoverPlexServers,
  authenticateJellyfinServer,
  syncSingleServerContent,
  removeExternalServerAndPurge,
  type ExternalMediaServerConfig,
} from "../lib/externalServers";

type SettingsSection = "libraries" | "passes" | "external_servers" | "apikeys" | "playback" | "rclone" | "adult" | "sync" | "diagnostics" | "trakt" | "transcoder" | "dlna" | "debrid" | "streamtape" | "telegram" | "udrop" | "storyteller" | "theme";

const LIBRARY_TYPES: { value: LibraryType; label: string }[] = [
  { value: "movies", label: "Movies" },
  { value: "tv", label: "TV Shows" },
  { value: "music", label: "Music" },
  { value: "audiobooks", label: "Audiobooks" },
  { value: "books", label: "Books (EPUB/PDF)" },
  { value: "comics", label: "Comics & Manga (CBZ/CBR)" },
  { value: "adult", label: "Adult Content" },
  { value: "photos", label: "Photos" },
];

export function SettingsPage() {
  const {
    tmdbApiKey,
    thePornDbApiKey,
    stashBoxProviders,
    setStashBoxProviders,
    experimentalPhashEnabled,
    setExperimentalPhashEnabled,
    googleClientId,
    rcloneConfigPath,
    libraries,
    remotes,
    syncState,
    scanState,
    adultSettings,
    playback,
    localStorageCapMb,
    setLocalStorageCapMb,
    artworkRemoteMirrorEnabled,
    setArtworkRemoteMirrorEnabled,
    setPlaybackSettings,
    setTmdbApiKey,
    setThePornDbApiKey,
    setGoogleClientId,
    addLibrary,
    removeLibrary,
    updateLibrary,
    setAdultPin,
    setAdultHidden,
    clearAdultPin,
    issuedPasses,
    removeIssuedPass,
    simklSettings,
    setSimklSettings,
    traktSettings,
    setTraktSettings,
    kaggleUsername,
    kaggleKey,
    setKaggleUsername,
    setKaggleKey,
    setRcloneConfigPath,
    setRemotes,
    setRcloneConfigContent,
    easynewsConfig,
    setEasynewsConfig,
    debridConfig,
    setDebridConfig,
    stremioAddons,
    addStremioAddon,
    removeStremioAddon,
    toggleStremioAddon,
    rcloneSettings,
    setRcloneSettings,
    storytellerConfig,
    setStorytellerConfig,
    ghaConfig,
    setGhaConfig,
    ghaAccounts,
    setGhaAccounts,
    kaggleAccounts,
    setKaggleAccounts,
    themeConfig,
    setThemeConfig,
  } = useAppStore();

  const [section, setSection] = useState<SettingsSection>("libraries");
  const [version, setVersion] = useState("");

  // Rclone Streaming & Rate Limiting state
  const [localRclone, setLocalRclone] = useState<RcloneSettings>(rcloneSettings || defaultRcloneSettings);
  const [savedRclone, setSavedRclone] = useState(false);

  useEffect(() => {
    if (rcloneSettings) {
      setLocalRclone(rcloneSettings);
    }
  }, [rcloneSettings]);

  const [showVirtualRemoteModal, setShowVirtualRemoteModal] = useState(false);

  const handleSaveRcloneSettings = async () => {
    const rawTrash = (localRclone.softDeleteTrashDir ?? ".rcloneflix_trash").trim().replace(/^\/+|\/+$/g, "");
    if (localRclone.softDeleteEnabled && rawTrash && !isValidSoftDeleteTrashDir(rawTrash)) {
      useToastStore.getState().addToast(
        "App Trash Folder Name may only contain letters, numbers, '.', '_', and '-' (no spaces, slashes, or glob characters).",
        "error"
      );
      return;
    }
    const safeTrashDir = isValidSoftDeleteTrashDir(rawTrash) ? rawTrash : ".rcloneflix_trash";
    const normalized: RcloneSettings = {
      ...localRclone,
      bwLimit: localRclone.bwLimit?.trim() ? localRclone.bwLimit.trim() : null,
      softDeleteTrashDir: safeTrashDir,
    };
    try {
      await saveRcloneSettings(normalized);
      setRcloneSettings(normalized);
      setLocalRclone(normalized);
      setSavedRclone(true);
      useToastStore.getState().addToast("Rclone streaming & rate limiting settings saved!", "success");
      setTimeout(() => setSavedRclone(false), 2500);
    } catch (err: any) {
      useToastStore.getState().addToast(`Failed to save Rclone settings: ${err?.message || err}`, "error");
    }
  };

  // Access Pass modals
  const [showCreatePassModal, setShowCreatePassModal] = useState(false);
  const [showImportPassModal, setShowImportPassModal] = useState(false);

  // Form states
  const [tmdbInput, setTmdbInput] = useState(tmdbApiKey);
  const [pornDbInput, setPornDbInput] = useState(thePornDbApiKey);
  const defaultStashProvider: StashBoxProvider = (stashBoxProviders && stashBoxProviders[0]) || {
    id: "stashdb",
    name: "StashDB",
    endpoint: "https://stashdb.org/graphql",
    apiKey: "",
    enabled: false,
  };
  const [stashEndpoint, setStashEndpoint] = useState(defaultStashProvider.endpoint);
  const [stashApiKey, setStashApiKey] = useState(defaultStashProvider.apiKey);
  const [stashEnabled, setStashEnabled] = useState(defaultStashProvider.enabled);
  const [testingStash, setTestingStash] = useState(false);
  const [savedApiKeys, setSavedApiKeys] = useState(false);

  // Kaggle Transcoder states
  const [kaggleUserInput, setKaggleUserInput] = useState(kaggleUsername);
  const [kaggleKeyInput, setKaggleKeyInput] = useState(kaggleKey);
  const [savedKaggle, setSavedKaggle] = useState(false);
  const [testingKaggle, setTestingKaggle] = useState(false);
  const [kaggleTestResult, setKaggleTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [syncingPasses, setSyncingPasses] = useState(false);

  // GitHub Actions Worker Rotation states
  const [ghaEnabled, setGhaEnabled] = useState(ghaConfig?.enabled ?? false);
  const [ghaTokenInput, setGhaTokenInput] = useState(ghaConfig?.token ?? "");
  const [ghaOwnerInput, setGhaOwnerInput] = useState(ghaConfig?.owner ?? "");
  const [ghaRepoInput, setGhaRepoInput] = useState(ghaConfig?.repo || DEFAULT_GHA_WORKER_REPO);
  const [ghaAllowPublic, setGhaAllowPublic] = useState(ghaConfig?.allowPublicRepo ?? false);
  const [testingGha, setTestingGha] = useState(false);
  const [provisioningGha, setProvisioningGha] = useState(false);
  const [ghaTestResult, setGhaTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [savedGha, setSavedGha] = useState(false);

  // Backup accounts form state
  const [showAddGha, setShowAddGha] = useState(false);
  const [newGhaLabel, setNewGhaLabel] = useState("");
  const [newGhaOwner, setNewGhaOwner] = useState("");
  const [newGhaRepo, setNewGhaRepo] = useState("");
  const [newGhaToken, setNewGhaToken] = useState("");

  const [showAddKaggle, setShowAddKaggle] = useState(false);
  const [newKaggleLabel, setNewKaggleLabel] = useState("");
  const [newKaggleUser, setNewKaggleUser] = useState("");
  const [newKaggleKey, setNewKaggleKey] = useState("");

  useEffect(() => {
    if (ghaConfig) {
      setGhaEnabled(ghaConfig.enabled);
      setGhaTokenInput(ghaConfig.token);
      setGhaOwnerInput(ghaConfig.owner);
      setGhaRepoInput(ghaConfig.repo || DEFAULT_GHA_WORKER_REPO);
      setGhaAllowPublic(ghaConfig.allowPublicRepo ?? false);
    }
  }, [ghaConfig]);

  useEffect(() => {
    if (section === "passes") {
      syncIssuedPasses().catch(() => {});
    }
  }, [section]);

  // Trakt / Simkl states
  const [traktClientIdInput, setTraktClientIdInput] = useState(traktSettings?.clientId || "");
  const [traktTokenInput, setTraktTokenInput] = useState(traktSettings?.accessToken || "");
  const [savedTrakt, setSavedTrakt] = useState(false);
  const [refreshingTrakt, setRefreshingTrakt] = useState(false);

  // Simkl Device PIN state
  const [simklPinState, setSimklPinState] = useState<SimklPinResponse | null>(null);
  const [isPinRequesting, setIsPinRequesting] = useState(false);
  const pinPollIntervalRef = useRef<any>(null);

  // Easynews states
  const [easynewsUsername, setEasynewsUsername] = useState(easynewsConfig?.username || "");
  const [easynewsPassword, setEasynewsPassword] = useState(easynewsConfig?.password || "");
  const [easynewsPort, setEasynewsPort] = useState(easynewsConfig?.port || 443);
  const [easynewsEnabled, setEasynewsEnabled] = useState(easynewsConfig?.enabled ?? false);
  const [testingEasynews, setTestingEasynews] = useState(false);
  const [easynewsTestResult, setEasynewsTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [savedEasynews, setSavedEasynews] = useState(false);

  // Debrid states
  const [realDebridKey, setRealDebridKey] = useState(debridConfig?.realDebridApiKey || "");
  const [premiumizeKey, setPremiumizeKey] = useState(debridConfig?.premiumizeApiKey || "");
  const [offcloudKey, setOffcloudKey] = useState(debridConfig?.offcloudApiKey || "");
  const [testingDebrid, setTestingDebrid] = useState<string | null>(null);
  const [debridTestResult, setDebridTestResult] = useState<{ provider: string; ok: boolean; message: string } | null>(null);
  const [savedDebrid, setSavedDebrid] = useState(false);

  // Stremio Addon states
  const [newStremioUrl, setNewStremioUrl] = useState("");
  const [addingStremio, setAddingStremio] = useState(false);

  const handleAddStremioAddon = async () => {
    if (!newStremioUrl.trim()) return;
    setAddingStremio(true);
    try {
      const addon = await validateAndFetchStremioAddon(newStremioUrl.trim());
      addStremioAddon(addon);
      setNewStremioUrl("");
      useToastStore.getState().addToast(`Added Stremio Addon: ${addon.name}`, "success");
    } catch (err: any) {
      useToastStore.getState().addToast(`Failed to add addon: ${err?.message || String(err)}`, "error");
    } finally {
      setAddingStremio(false);
    }
  };

  // Storyteller states
  const [storytellerUrl, setStorytellerUrl] = useState(storytellerConfig?.serverUrl || "");
  const [storytellerApiKey, setStorytellerApiKey] = useState(storytellerConfig?.apiKey || "");
  const [storytellerAutoSync, setStorytellerAutoSync] = useState(storytellerConfig?.autoSync ?? false);
  const [testingStoryteller, setTestingStoryteller] = useState(false);
  const [storytellerTestResult, setStorytellerTestResult] = useState<{ ok: boolean; message: string; bookCount?: number } | null>(null);
  const [fetchingStorytellerBooks, setFetchingStorytellerBooks] = useState(false);
  const [storytellerBooks, setStorytellerBooks] = useState<StorytellerBook[]>([]);
  const [savedStoryteller, setSavedStoryteller] = useState(false);

  useEffect(() => {
    return () => {
      if (pinPollIntervalRef.current) clearInterval(pinPollIntervalRef.current);
    };
  }, []);


  // Telegram Drive WebDAV modal states
  const [showTelegramModal, setShowTelegramModal] = useState(false);
  const [telegramRemoteName, setTelegramRemoteName] = useState("telegram-drive");
  const [telegramUrl, setTelegramUrl] = useState("http://127.0.0.1:8551/dav/fd881c0f554f776020c2b1edeae05899af73142dc3d768ab029638b9f01ca33d/");
  const [telegramUser, setTelegramUser] = useState("");
  const [telegramPass, setTelegramPass] = useState("");
  const [isConnectingTelegram, setIsConnectingTelegram] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);

  // DLNA & Xbox Casting state
  const [dlnaStatus, setDlnaStatus] = useState<DlnaStatus | null>(null);
  const [dlnaRemote, setDlnaRemote] = useState<string>("telegram-drive");
  const [dlnaPath, setDlnaPath] = useState<string>("");
  const [dlnaPort, setDlnaPort] = useState<number>(8200);
  const [dlnaFriendlyName, setDlnaFriendlyName] = useState<string>("RcloneFlix (Xbox & TV)");
  const [isOperatingDlna, setIsOperatingDlna] = useState<boolean>(false);

  // Tailscale state
  const [tailscaleStatus, setTailscaleStatus] = useState<TailscaleStatusResult | null>(null);
  const [tailscaleRoutes, setTailscaleRoutes] = useState<TailscaleRoute[]>([]);
  const [loadingTailscale, setLoadingTailscale] = useState<boolean>(false);
  const [operatingTailscale, setOperatingTailscale] = useState<boolean>(false);

  const fetchTailscaleStatus = async () => {
    setLoadingTailscale(true);
    try {
      const [statusRes, routesRes] = await Promise.all([
        getTailscaleStatus().catch(() => null),
        getTailscaleRoutes().catch(() => null),
      ]);
      setTailscaleStatus(statusRes);
      setTailscaleRoutes(routesRes?.routes || []);
    } catch {
      setTailscaleStatus(null);
      setTailscaleRoutes([]);
    } finally {
      setLoadingTailscale(false);
    }
  };

  const handleEnableServe = async () => {
    setOperatingTailscale(true);
    try {
      await setTailscaleServe(8443, 8551);
      useToastStore.getState().addToast("Tailscale Serve enabled (Private Tailnet)", "success");
      await fetchTailscaleStatus();
    } catch (e: any) {
      useToastStore.getState().addToast(`Failed enabling Tailscale Serve: ${e}`, "error");
    } finally {
      setOperatingTailscale(false);
    }
  };

  const handleEnableFunnel = async () => {
    setOperatingTailscale(true);
    try {
      await setTailscaleFunnel(8443, 8551);
      useToastStore.getState().addToast("Tailscale Funnel enabled (Public Internet)", "success");
      await fetchTailscaleStatus();
    } catch (e: any) {
      useToastStore.getState().addToast(`Failed enabling Tailscale Funnel: ${e}`, "error");
    } finally {
      setOperatingTailscale(false);
    }
  };

  const handleResetTailscale = async () => {
    setOperatingTailscale(true);
    try {
      await resetTailscaleRoutes();
      useToastStore.getState().addToast("Tailscale routes reset", "info");
      await fetchTailscaleStatus();
    } catch (e: any) {
      useToastStore.getState().addToast(`Failed resetting routes: ${e}`, "error");
    } finally {
      setOperatingTailscale(false);
    }
  };

  useEffect(() => {
    if (section === "dlna" || section === "libraries") {
      getDlnaStatus().then(setDlnaStatus).catch(() => {});
      fetchTailscaleStatus();
    }
  }, [section]);

  useEffect(() => {
    if (remotes.length > 0 && !remotes.some((r) => r.name === dlnaRemote)) {
      const td = remotes.find((r) => r.name === "telegram-drive" || r.name === "telegram");
      setDlnaRemote(td ? td.name : remotes[0].name);
    }
  }, [remotes]);

  const handleToggleDlna = async () => {
    setIsOperatingDlna(true);
    try {
      if (dlnaStatus?.running) {
        const res = await stopDlnaServer();
        setDlnaStatus(res);
        useToastStore.getState().addToast("DLNA Media Server stopped", "success");
      } else {
        const res = await startDlnaServer(
          rcloneConfigPath,
          dlnaRemote,
          dlnaPath,
          dlnaPort,
          dlnaFriendlyName
        );
        setDlnaStatus(res);
        useToastStore.getState().addToast(`DLNA Server active on port ${res.port}! Ready for Xbox & Smart TVs.`, "success");
      }
    } catch (err: any) {
      useToastStore.getState().addToast(err?.message || String(err) || "Failed to operate DLNA server", "error");
    } finally {
      setIsOperatingDlna(false);
    }
  };

  const handleConnectTelegram = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = telegramRemoteName.trim() || "telegram";
    const url = telegramUrl.trim();
    if (!url) {
      setTelegramError("WebDAV URL is required (e.g. http://127.0.0.1:8080/webdav)");
      return;
    }
    setIsConnectingTelegram(true);
    setTelegramError(null);
    try {
      const updated = await rcloneCreateWebdavRemote(
        rcloneConfigPath,
        name,
        url,
        telegramUser.trim() || undefined,
        telegramPass.trim() || undefined
      );
      useAppStore.getState().setRemotes(updated.map((r) => ({ name: r.name, type: r.remote_type })));
      useToastStore.getState().addToast(`Connected Telegram Drive remote "${name}"!`, "success");
      setShowTelegramModal(false);
    } catch (err: any) {
      setTelegramError(err.message || String(err) || "Failed to configure Telegram Drive WebDAV remote");
    } finally {
      setIsConnectingTelegram(false);
    }
  };

  const handleSaveKaggle = () => {
    setKaggleUsername(kaggleUserInput.trim());
    setKaggleKey(kaggleKeyInput.trim());
    setSavedKaggle(true);
    useToastStore.getState().addToast("Saved Kaggle credentials to secure store", "success");
    setTimeout(() => setSavedKaggle(false), 2000);
  };

  const handleTestKaggle = async () => {
    setTestingKaggle(true);
    setKaggleTestResult(null);
    try {
      const res = await testKaggleConnection(kaggleUserInput.trim(), kaggleKeyInput.trim());
      setKaggleTestResult(res);
      if (res.ok) {
        useToastStore.getState().addToast(res.message, "success");
      } else {
        useToastStore.getState().addToast(res.message, "error");
      }
    } catch (e: any) {
      const msg = e.message || String(e);
      setKaggleTestResult({ ok: false, message: msg });
      useToastStore.getState().addToast(msg, "error");
    } finally {
      setTestingKaggle(false);
    }
  };

  const handleImportKaggleJson = async () => {
    try {
      const creds = await importKaggleJson();
      if (creds.username && creds.key) {
        setKaggleUserInput(creds.username);
        setKaggleKeyInput(creds.key);
        setKaggleUsername(creds.username);
        setKaggleKey(creds.key);
        useToastStore.getState().addToast(`Imported credentials for @${creds.username} from ~/kaggle.json`, "success");
      }
    } catch (e: any) {
      useToastStore.getState().addToast(e.message || String(e), "error");
    }
  };

  const handleSaveGha = () => {
    setGhaConfig({
      enabled: ghaEnabled,
      token: ghaTokenInput.trim(),
      owner: ghaOwnerInput.trim(),
      repo: ghaRepoInput.trim() || DEFAULT_GHA_WORKER_REPO,
      allowPublicRepo: ghaAllowPublic,
    });
    setSavedGha(true);
    useToastStore.getState().addToast("Saved GitHub Actions runner configuration", "success");
    setTimeout(() => setSavedGha(false), 2000);
  };

  const handleProvisionGha = async (forceSync: boolean) => {
    setProvisioningGha(true);
    setGhaTestResult(null);
    try {
      const res = await ensureGitHubWorkerReady({
        token: ghaTokenInput.trim(),
        owner: ghaOwnerInput.trim() || undefined,
        repo: ghaRepoInput.trim() || DEFAULT_GHA_WORKER_REPO,
        workflowFile: ghaConfig?.workflowFile,
        forceSync,
        allowPublic: ghaAllowPublic,
      });
      setGhaOwnerInput(res.owner);
      setGhaRepoInput(res.repo);
      setGhaTestResult({ ok: true, message: res.statusMessage });
      useToastStore.getState().addToast(res.statusMessage, "success");
    } catch (err: any) {
      const msg = err?.message || "Failed to provision GitHub Actions worker";
      setGhaTestResult({ ok: false, message: msg });
      useToastStore.getState().addToast(msg, "error");
    } finally {
      setProvisioningGha(false);
    }
  };

  const handleTestGha = async () => {
    setTestingGha(true);
    setGhaTestResult(null);
    try {
      const res = await testGitHubActionsConnection(
        ghaTokenInput.trim(),
        ghaOwnerInput.trim(),
        ghaRepoInput.trim()
      );
      setGhaTestResult(res);
      if (res.ok) {
        useToastStore.getState().addToast(res.message, "success");
      } else {
        useToastStore.getState().addToast(res.message, "error");
      }
    } catch (err: any) {
      const msg = err?.message || "Failed to test GitHub Actions connection";
      setGhaTestResult({ ok: false, message: msg });
      useToastStore.getState().addToast(msg, "error");
    } finally {
      setTestingGha(false);
    }
  };

  useEffect(() => {
    if (section === "transcoder" && (!kaggleUserInput || !kaggleKeyInput)) {
      loadKaggleCredentials().then((creds) => {
        if (creds.username && creds.key) {
          setKaggleUserInput(creds.username);
          setKaggleKeyInput(creds.key);
          setKaggleUsername(creds.username);
          setKaggleKey(creds.key);
        }
      }).catch(() => {});
    }
  }, [section]);

  const handleSaveTraktCredentials = async () => {
    const cid = traktClientIdInput.trim();
    setTraktSettings({
      clientId: cid,
      accessToken: traktTokenInput.trim(),
      discoveryShelvesEnabled: true,
      enabled: true,
    });
    setSavedTrakt(true);
    useToastStore.getState().addToast("Simkl credentials saved! Updating discovery shelves...", "success");
    setTimeout(() => setSavedTrakt(false), 2000);
    setRefreshingTrakt(true);
    const ok = await refreshSimklDiscovery(true);
    setRefreshingTrakt(false);
    if (ok) {
      useToastStore.getState().addToast("Discovery shelves updated!", "success");
    }
  };

  const handleDisconnectSimkl = () => {
    const store = useAppStore.getState();
    store.setSimklSettings({
      accessToken: "",
      scrobbleEnabled: false,
    });
    setTraktTokenInput("");
    useToastStore.getState().addToast("Simkl account disconnected.", "info");
  };

  const handleRefreshTraktDiscoveryNow = async () => {
    setRefreshingTrakt(true);
    const ok = await refreshSimklDiscovery(true);
    setRefreshingTrakt(false);
    if (ok) {
      useToastStore.getState().addToast("Discovery shelves updated!", "success");
    } else {
      useToastStore.getState().addToast("Failed to refresh discovery shelves.", "error");
    }
  };

  const handleStartSimklPin = async () => {
    const cid = traktClientIdInput.trim() || simklSettings?.clientId?.trim();
    if (!cid) {
      useToastStore.getState().addToast(
        "Please enter your Simkl Client ID first. Click the link to create a free app in 10 seconds.",
        "error"
      );
      return;
    }
    setIsPinRequesting(true);
    try {
      const pin = await getSimklPin(cid);
      setSimklPinState(pin);
      if (pinPollIntervalRef.current) clearInterval(pinPollIntervalRef.current);

      const pollInterval = Math.max(pin.interval || 5, 3) * 1000;
      pinPollIntervalRef.current = setInterval(async () => {
        try {
          const res = await pollSimklPin(pin.user_code, cid);
          if (res.result === "OK" && res.access_token) {
            if (pinPollIntervalRef.current) {
              clearInterval(pinPollIntervalRef.current);
              pinPollIntervalRef.current = null;
            }
            setSimklPinState(null);
            setTraktTokenInput(res.access_token);
            setTraktClientIdInput(cid);
            const store = useAppStore.getState();
            store.setSimklSettings({
              clientId: cid,
              accessToken: res.access_token,
              enabled: true,
              scrobbleEnabled: true,
              discoveryShelvesEnabled: true,
            });
            useToastStore.getState().addToast("Simkl connected successfully! Scrobbling is now enabled.", "success");
            await refreshSimklDiscovery(true);
          }
        } catch {
          // ignore error while polling
        }
      }, pollInterval);
    } catch (e: any) {
      useToastStore.getState().addToast(`Failed to generate Simkl PIN: ${e?.message || e}`, "error");
    } finally {
      setIsPinRequesting(false);
    }
  };

  const handleCancelSimklPin = () => {
    if (pinPollIntervalRef.current) {
      clearInterval(pinPollIntervalRef.current);
      pinPollIntervalRef.current = null;
    }
    setSimklPinState(null);
  };

  const handleSaveEasynews = () => {
    setEasynewsConfig({
      username: easynewsUsername.trim(),
      password: easynewsPassword.trim(),
      port: Number(easynewsPort) || 443,
      enabled: easynewsEnabled,
    });
    setSavedEasynews(true);
    setTimeout(() => setSavedEasynews(false), 2000);
    useToastStore.getState().addToast("Easynews settings saved", "success");
  };

  const handleTestEasynews = async () => {
    setTestingEasynews(true);
    setEasynewsTestResult(null);
    try {
      const res = await testEasynewsConnection(
        easynewsUsername.trim(),
        easynewsPassword.trim(),
        Number(easynewsPort) || 443
      );
      setEasynewsTestResult(res);
    } catch (e: any) {
      setEasynewsTestResult({ ok: false, message: `Connection error: ${e?.message || e}` });
    } finally {
      setTestingEasynews(false);
    }
  };

  const handleSaveDebrid = () => {
    setDebridConfig({
      realDebridApiKey: realDebridKey.trim(),
      premiumizeApiKey: premiumizeKey.trim(),
      offcloudApiKey: offcloudKey.trim(),
    });
    setSavedDebrid(true);
    setTimeout(() => setSavedDebrid(false), 2000);
    useToastStore.getState().addToast("Debrid & Resolver settings saved", "success");
  };

  const handleTestDebrid = async (provider: "realdebrid" | "premiumize" | "offcloud") => {
    setTestingDebrid(provider);
    setDebridTestResult(null);
    try {
      let res = { ok: false, message: "" };
      let name = "";
      if (provider === "realdebrid") {
        name = "Real-Debrid";
        res = await testRealDebridKey(realDebridKey.trim());
      } else if (provider === "premiumize") {
        name = "Premiumize.me";
        res = await testPremiumizeKey(premiumizeKey.trim());
      } else if (provider === "offcloud") {
        name = "Offcloud";
        res = await testOffcloudKey(offcloudKey.trim());
      }
      setDebridTestResult({
        provider,
        ok: res.ok,
        message: res.message || (res.ok ? `Successfully connected to ${name}!` : `Failed to authenticate with ${name}. Check your API token.`),
      });
    } catch (e: any) {
      setDebridTestResult({ provider, ok: false, message: `Error: ${e?.message || e}` });
    } finally {
      setTestingDebrid(null);
    }
  };

  const handleSaveStoryteller = () => {
    setStorytellerConfig({
      serverUrl: storytellerUrl.trim(),
      apiKey: storytellerApiKey.trim(),
      autoSync: storytellerAutoSync,
    });
    setSavedStoryteller(true);
    setTimeout(() => setSavedStoryteller(false), 2000);
    useToastStore.getState().addToast("Storyteller settings saved", "success");
  };

  const handleTestStoryteller = async () => {
    setTestingStoryteller(true);
    setStorytellerTestResult(null);
    try {
      const res = await testStorytellerConnection(storytellerUrl.trim(), storytellerApiKey.trim());
      setStorytellerTestResult(res);
      if (res.ok) {
        handleSaveStoryteller();
      }
    } catch (e: any) {
      setStorytellerTestResult({ ok: false, message: e?.message || "Failed to reach server." });
    } finally {
      setTestingStoryteller(false);
    }
  };

  const handleFetchStorytellerBooks = async () => {
    setFetchingStorytellerBooks(true);
    try {
      const books = await fetchStorytellerBooks(storytellerUrl.trim(), storytellerApiKey.trim());
      setStorytellerBooks(books);
      useToastStore.getState().addToast(`Loaded ${books.length} synced books from Storyteller!`, "success");
    } catch (e: any) {
      useToastStore.getState().addToast("Failed to fetch books from Storyteller", "error");
    } finally {
      setFetchingStorytellerBooks(false);
    }
  };

  const [showPasteConfigModal, setShowPasteConfigModal] = useState(false);
  const [pasteConfigText, setPasteConfigText] = useState("");

  const handleBrowseRcloneConfig = async () => {
    try {
      const selected = await pickRcloneConfig();
      if (selected) {
        setRcloneConfigPath(selected);
        let content = "";
        try {
          content = await readTextFile(selected);
        } catch {}
        if (!content || content.startsWith("\0")) {
          try {
            content = await invoke<string>("load_rclone_config_content");
          } catch {}
        }
        if (content && !content.startsWith("\0") && content.includes("[")) {
          setRcloneConfigContent(content);
          await invoke("save_rclone_config_content", { content }).catch(() => {});
        }
        const parsed = await parseRcloneConfig(selected);
        setRemotes(parsed.map((r) => ({ name: r.name, type: r.remote_type })));
        useToastStore.getState().addToast(`Loaded ${parsed.length} remotes from ${selected}`, "success");
      }
    } catch (e: any) {
      useToastStore.getState().addToast(`Failed loading config: ${e?.message || e}`, "error");
    }
  };

  const handleSavePastedConfig = async () => {
    const trimmed = pasteConfigText.trim();
    if (!trimmed || !trimmed.includes("[")) {
      useToastStore.getState().addToast("Please paste a valid rclone.conf containing at least one [remote] section.", "error");
      return;
    }
    try {
      setRcloneConfigContent(trimmed);
      await invoke("save_rclone_config_content", { content: trimmed });
      const parsed = await parseRcloneConfig(rcloneConfigPath || "");
      setRemotes(parsed.map((r) => ({ name: r.name, type: r.remote_type })));
      setShowPasteConfigModal(false);
      useToastStore.getState().addToast(`Saved rclone.conf and loaded ${parsed.length} remotes!`, "success");
    } catch (e: any) {
      useToastStore.getState().addToast(`Failed saving config: ${e?.message || e}`, "error");
    }
  };

  const handleReloadRemotes = async () => {
    try {
      const freshContent = await invoke<string>("load_rclone_config_content").catch(() => "");
      if (freshContent && !freshContent.startsWith("\0") && freshContent.includes("[")) {
        setRcloneConfigContent(freshContent);
      }
      const targetPath = rcloneConfigPath || "";
      const parsed = await parseRcloneConfig(targetPath);
      setRemotes(parsed.map((r) => ({ name: r.name, type: r.remote_type })));
      useToastStore.getState().addToast(`Refreshed ${parsed.length} remotes`, "success");
    } catch (e: any) {
      useToastStore.getState().addToast(`Failed reloading remotes: ${e?.message || e}`, "error");
    }
  };

  // New/editing library state
  const [newLib, setNewLib] = useState<{ name: string; type: LibraryType; remotePaths: string[] } | null>(null);
  const [editingLib, setEditingLib] = useState<Library | null>(null);

  // Remote browser modal state
  const [showBrowserFor, setShowBrowserFor] = useState<{ mode: "new" | "edit"; pathIndex: number } | null>(null);

  // Adult PIN form state
  const [pinInput, setPinInput] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");

  // Diagnostics
  const [logPath, setLogPath] = useState("");
  const [logTail, setLogTail] = useState("");

  const refreshLog = async () => {
    try {
      setLogTail(await readLogTail(500));
    } catch (e) {
      setLogTail(`Could not read log: ${e}`);
    }
  };

  useEffect(() => {
    if (section !== "diagnostics") return;
    getLogPath().then(setLogPath).catch(() => {});
    void refreshLog();
  }, [section]);

  // Sync state
  const [syncMsg, setSyncMsg] = useState("");
  const [backupFolder, setBackupFolder] = useState(
    () => localStorage.getItem("rcloneflix-backup-folder") ?? ""
  );
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [showBackupBrowser, setShowBackupBrowser] = useState<"folder" | "file" | null>(null);
  const [artStats, setArtStats] = useState<{ files: number; bytes: number } | null>(null);
  const [photoStats, setPhotoStats] = useState<{ files: number; bytes: number } | null>(null);

  useEffect(() => {
    if (section === "sync") {
      artworkCacheStats().then(setArtStats).catch(() => {});
      vaultPhotoCacheStats().then(setPhotoStats).catch(() => {});
    }
  }, [section]);

  useEffect(() => {
    if (backupFolder) localStorage.setItem("rcloneflix-backup-folder", backupFolder);
  }, [backupFolder]);

  const handleRemoteBackup = async () => {
    setSyncMsg("Backing up…");
    try {
      const isEncrypted = Boolean(backupPassphrase.trim());
      const bytes = await backupToRemote(backupFolder.trim(), backupPassphrase.trim() || undefined);
      setSyncMsg(`✓ Backed up (${(bytes / 1024).toFixed(0)} KB)${isEncrypted ? " [AES-256]" : ""}`);
      useToastStore
        .getState()
        .addToast(
          isEncrypted
            ? "Encrypted backup (AES-256-GCM) written to remote"
            : "Backup written to remote",
          "success"
        );
    } catch (e) {
      setSyncMsg("");
      useToastStore.getState().addToast(`Backup failed: ${e}`, "error", 8000);
    }
    setTimeout(() => setSyncMsg(""), 5000);
  };

  const handleRemoteRestore = async (remotePath: string) => {
    setSyncMsg("Restoring…");
    try {
      const r = await restoreFromRemote(remotePath, {
        passphrase: backupPassphrase.trim() || undefined,
      });
      setSyncMsg("");
      useToastStore
        .getState()
        .addToast(
          `Restored from ${r.deviceName}: +${r.itemsAdded} items, ${r.progressUpdated} progress updates`,
          "success",
          8000
        );
    } catch (e) {
      setSyncMsg("");
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ENCRYPTED_BACKUP")) {
        useToastStore
          .getState()
          .addToast(
            "Encrypted backup detected! Please enter the Backup Passphrase below and click restore again.",
            "error",
            10000
          );
      } else {
        useToastStore.getState().addToast(`Restore failed: ${msg}`, "error", 8000);
      }
    }
  };

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  useEffect(() => {
    setTmdbInput(tmdbApiKey);
    setPornDbInput(thePornDbApiKey);
    setKaggleUserInput(kaggleUsername);
    setKaggleKeyInput(kaggleKey);
  }, [tmdbApiKey, thePornDbApiKey, kaggleUsername, kaggleKey]);


  const handleSaveApiKeys = () => {
    setTmdbApiKey(tmdbInput.trim());
    setThePornDbApiKey(pornDbInput.trim());
    setSavedApiKeys(true);
    useToastStore.getState().addToast("Settings & API keys saved successfully!", "success");
    setTimeout(() => setSavedApiKeys(false), 2500);
  };

  const handleAddLibrary = () => {
    if (!newLib) return;
    const cleanPaths = newLib.remotePaths
      .map((p) => {
        const trimmed = p.trim();
        if (trimmed && !trimmed.includes(":") && !trimmed.startsWith("/") && !trimmed.startsWith(".") && !trimmed.startsWith("\\")) {
          return `${trimmed}:`;
        }
        return trimmed;
      })
      .filter(Boolean);
    if (!newLib.name.trim() || cleanPaths.length === 0) {
      useToastStore.getState().addToast("Please provide a name and at least one folder path (remote or local)", "error");
      return;
    }

    addLibrary({
      id: `lib-${Date.now()}`,
      name: newLib.name.trim(),
      type: newLib.type,
      remotePaths: cleanPaths,
    });

    if (newLib.type === "photos") {
      const firstPath = cleanPaths[0] || "";
      const isLocal = isLocalPath(firstPath);
      const remote = isLocal ? "LOCAL" : firstPath.split(":")[0] || "Photos";
      const folder = isLocal ? firstPath : firstPath.split(":")[1] || "Photos";
      const { photoSettings, setPhotoSettings } = useAppStore.getState();
      if (!photoSettings.configured) {
        setPhotoSettings({
          configured: true,
          remoteName: remote,
          folder,
          isEncrypted: remote.toLowerCase().includes("crypt"),
        });
      }
    }

    setNewLib(null);
    useToastStore.getState().addToast("Library added successfully!", "success");
  };

  const handleSaveLibEdit = () => {
    if (!editingLib) return;
    const cleanPaths = editingLib.remotePaths
      .map((p) => {
        const trimmed = p.trim();
        if (trimmed && !trimmed.includes(":") && !trimmed.startsWith("/") && !trimmed.startsWith(".") && !trimmed.startsWith("\\")) {
          return `${trimmed}:`;
        }
        return trimmed;
      })
      .filter(Boolean);
    if (cleanPaths.length === 0) {
      useToastStore.getState().addToast("Please provide at least one valid folder path (remote or local)", "error");
      return;
    }

    updateLibrary(editingLib.id, {
      name: editingLib.name.trim() || editingLib.type,
      type: editingLib.type,
      remotePaths: cleanPaths,
    });
    setEditingLib(null);
    useToastStore.getState().addToast("Library updated successfully!", "success");
  };

  const handleSetPin = async () => {
    const pin = pinInput.trim();
    const confirmPin = pinConfirm.trim();

    if (!/^\d+$/.test(pin) || ![4, 5, 6].includes(pin.length)) {
      useToastStore.getState().addToast("PIN must be 4, 5 or 6 digits", "error");
      return;
    }
    if (pin !== confirmPin) {
      useToastStore.getState().addToast("PINs do not match", "error");
      return;
    }

    setAdultPin(await hashPin(pin), pin.length as 4 | 5 | 6);
    setPinInput("");
    setPinConfirm("");
    useToastStore.getState().addToast("Adult PIN set — the library is now locked", "success");
  };

  const handleClearPin = () => {
    clearAdultPin();
    setPinInput("");
    setPinConfirm("");
    useToastStore.getState().addToast("Adult PIN removed", "info");
  };

  const browserTargetPath = showBrowserFor
    ? showBrowserFor.mode === "new"
      ? newLib?.remotePaths[showBrowserFor.pathIndex] ?? ""
      : editingLib?.remotePaths[showBrowserFor.pathIndex] ?? ""
    : "";

  const colonIdx = browserTargetPath.indexOf(":");
  const activeRemoteName = colonIdx >= 0 ? browserTargetPath.slice(0, colonIdx) : (remotes[0]?.name ?? "");
  const activeRemoteObj = remotes.find((r) => r.name === activeRemoteName) ?? remotes[0];

  return (
    <div className="flex h-full">
      {/* Settings Sub-nav */}
      <div className="w-56 bg-surface/50 border-r border-border p-4 flex flex-col gap-1">
        <h2 className="px-3 py-2 font-display text-lg text-bright tracking-wider">SETTINGS</h2>
        <nav className="space-y-1">
          <button
            onClick={() => setSection("libraries")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "libraries" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Folder size={16} /> Libraries
          </button>
          <button
            onClick={() => setSection("passes")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "passes" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Share2 size={16} /> Shared Passes
          </button>
          <button
            onClick={() => setSection("apikeys")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "apikeys" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Key size={16} /> API Keys & Client ID
          </button>
          <button
            onClick={() => setSection("playback")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "playback" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Play size={16} /> Playback
          </button>
          <button
            onClick={() => setSection("rclone")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "rclone" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <HardDrive size={16} /> Rclone &amp; Streaming
          </button>
          <button
            onClick={() => setSection("adult")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "adult" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Shield size={16} /> Adult & Privacy
          </button>
          <button
            onClick={() => setSection("diagnostics")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "diagnostics" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <AlertCircle size={16} /> Diagnostics
          </button>
          <button
            onClick={() => setSection("sync")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "sync" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Cloud size={16} /> Backup & Restore
          </button>
          <button
            onClick={() => setSection("trakt")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "trakt" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Compass size={16} /> Scrobbling & Discovery
          </button>
          <button
            onClick={() => setSection("transcoder")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "transcoder" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Zap size={16} /> Cloud Transcoder
          </button>
          <button
            onClick={() => setSection("dlna")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "dlna" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Cast size={16} /> Cast, DLNA &amp; Remote
          </button>
          <button
            onClick={() => setSection("debrid")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "debrid" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Globe size={16} /> Easynews &amp; Debrid
          </button>
          <button
            onClick={() => setSection("external_servers")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "external_servers" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Server size={16} /> Plex &amp; Jellyfin
          </button>
          <button
            onClick={() => setSection("streamtape")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "streamtape" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Film size={16} /> Cyberlocker Relay &amp; Offload
          </button>
          <button
            onClick={() => setSection("telegram")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "telegram" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Send size={16} /> Telegram &amp; TG-Drive
          </button>
          <button
            onClick={() => setSection("udrop")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "udrop" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Cloud size={16} /> uDrop Direct Links
          </button>
          <button
            onClick={() => setSection("storyteller")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "storyteller" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <BookOpen size={16} /> Storyteller &amp; Alignment
          </button>
          <button
            onClick={() => setSection("theme")}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg font-body text-sm transition-colors ${
              section === "theme" ? "bg-panel text-accent font-semibold" : "text-subtle hover:text-text"
            }`}
          >
            <Palette size={16} /> Appearance &amp; Themes
          </button>
        </nav>

        <div className="mt-auto pt-4 border-t border-border">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-subtle">RcloneFlix v{version || "—"}</span>
          </div>
        </div>
      </div>

      {/* Main Settings Content */}
      <div className="flex-1 overflow-y-auto p-8">
        {section === "libraries" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="font-display text-3xl text-bright tracking-wide">LIBRARIES</h2>
                <p className="text-subtle font-body text-sm mt-1">Configure media folders mapped from your rclone remotes.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setTelegramError(null);
                    setShowTelegramModal(true);
                  }}
                  className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 hover:text-accent border border-accent/30"
                  title="Connect local Telegram-Drive desktop WebDAV endpoint"
                >
                  <HardDrive size={14} /> Add Telegram Drive (WebDAV)
                </button>
                {!newLib && (
                  <button
                    onClick={() => setNewLib({ name: "", type: "movies", remotePaths: [""] })}
                    className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5"
                  >
                    <Plus size={14} /> Add Library
                  </button>
                )}
              </div>
            </div>

            {/* Add New Library Form */}
            {newLib && (
              <div className="bg-panel border border-accent/40 rounded-xl p-5 mb-6 space-y-4 shadow-xl">
                <h3 className="text-accent font-heading font-semibold text-sm">Add New Library</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-subtle text-xs mb-1 block">Library Name</label>
                    <input
                      type="text"
                      value={newLib.name}
                      onChange={(e) => setNewLib({ ...newLib, name: e.target.value })}
                      placeholder="e.g. 4K Movies"
                      className="input-field text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-subtle text-xs mb-1 block">Library Type</label>
                    <select
                      value={newLib.type}
                      onChange={(e) => setNewLib({ ...newLib, type: e.target.value as LibraryType })}
                      className="input-field text-sm"
                    >
                      {LIBRARY_TYPES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="text-subtle text-xs mb-1.5 block">Folder Paths (Remote e.g. gdrive:Movies or Local e.g. /home/user/Movies)</label>
                  <div className="space-y-2">
                    {newLib.remotePaths.map((path, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={path}
                          onChange={(e) => {
                            const updated = [...newLib.remotePaths];
                            updated[i] = e.target.value;
                            setNewLib({ ...newLib, remotePaths: updated });
                          }}
                          placeholder="gdrive:Path or /home/user/Media"
                          className="input-field text-sm font-mono flex-1"
                        />
                        <button
                          type="button"
                          onClick={() => setShowBrowserFor({ mode: "new", pathIndex: i })}
                          className="btn-secondary text-xs py-2 px-3 flex-shrink-0 flex items-center gap-1"
                          title="Browse remote storage"
                        >
                          <Cloud size={12} />
                          Remote…
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            const picked = await pickLocalFolder();
                            if (picked) {
                              const updated = [...newLib.remotePaths];
                              updated[i] = picked;
                              setNewLib({ ...newLib, remotePaths: updated });
                            }
                          }}
                          className="btn-secondary text-xs py-2 px-3 flex-shrink-0 flex items-center gap-1"
                          title="Browse local computer folder"
                        >
                          <HardDrive size={12} />
                          Local…
                        </button>
                        {newLib.remotePaths.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              setNewLib({
                                ...newLib,
                                remotePaths: newLib.remotePaths.filter((_, j) => j !== i),
                              })
                            }
                            className="p-2 text-subtle hover:text-danger"
                          >
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setNewLib({ ...newLib, remotePaths: [...newLib.remotePaths, ""] })}
                    className="mt-2 text-accent text-xs font-body hover:underline flex items-center gap-1"
                  >
                    <Plus size={12} /> Add Another Folder Path
                  </button>
                </div>

                <div className="flex gap-2 pt-2 border-t border-white/10">
                  <button onClick={handleAddLibrary} className="btn-primary text-xs py-2 px-4">
                    Save Library
                  </button>
                  <button onClick={() => setNewLib(null)} className="btn-secondary text-xs py-2 px-4">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Configured Libraries List */}
            <div className="space-y-3">
              {libraries.map((lib) => (
                <div key={lib.id} className="bg-panel border border-border rounded-xl p-4">
                  {editingLib?.id === lib.id ? (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-subtle text-xs mb-1 block">Library Name</label>
                          <input
                            type="text"
                            value={editingLib.name}
                            onChange={(e) => setEditingLib({ ...editingLib, name: e.target.value })}
                            className="input-field text-sm"
                          />
                        </div>
                        <div>
                          <label className="text-subtle text-xs mb-1 block">Library Type</label>
                          <select
                            value={editingLib.type}
                            onChange={(e) => setEditingLib({ ...editingLib, type: e.target.value as LibraryType })}
                            className="input-field text-sm"
                          >
                            {LIBRARY_TYPES.map((t) => (
                              <option key={t.value} value={t.value}>{t.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="text-subtle text-xs mb-1.5 block">Folder Paths (Remote e.g. gdrive:Movies or Local e.g. /home/user/Movies)</label>
                        <div className="space-y-2">
                          {editingLib.remotePaths.map((path, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <input
                                type="text"
                                value={path}
                                onChange={(e) => {
                                  const updated = [...editingLib.remotePaths];
                                  updated[i] = e.target.value;
                                  setEditingLib({ ...editingLib, remotePaths: updated });
                                }}
                                placeholder="gdrive:Path or /home/user/Media"
                                className="input-field text-sm font-mono flex-1"
                              />
                              <button
                                type="button"
                                onClick={() => setShowBrowserFor({ mode: "edit", pathIndex: i })}
                                className="btn-secondary text-xs py-2 px-3 flex-shrink-0 flex items-center gap-1"
                                title="Browse remote storage"
                              >
                                <Cloud size={12} />
                                Remote…
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  const picked = await pickLocalFolder();
                                  if (picked) {
                                    const updated = [...editingLib.remotePaths];
                                    updated[i] = picked;
                                    setEditingLib({ ...editingLib, remotePaths: updated });
                                  }
                                }}
                                className="btn-secondary text-xs py-2 px-3 flex-shrink-0 flex items-center gap-1"
                                title="Browse local computer folder"
                              >
                                <HardDrive size={12} />
                                Local…
                              </button>
                              {editingLib.remotePaths.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEditingLib({
                                      ...editingLib,
                                      remotePaths: editingLib.remotePaths.filter((_, j) => j !== i),
                                    })
                                  }
                                  className="p-2 text-subtle hover:text-danger"
                                >
                                  <X size={16} />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => setEditingLib({ ...editingLib, remotePaths: [...editingLib.remotePaths, ""] })}
                          className="mt-2 text-accent text-xs font-body hover:underline flex items-center gap-1"
                        >
                          <Plus size={12} /> Add Another Folder Path
                        </button>
                      </div>

                      <div className="flex gap-2 pt-2 border-t border-white/10">
                        <button onClick={handleSaveLibEdit} className="btn-primary text-xs py-2 px-4 flex items-center gap-1">
                          <Save size={14} /> Save Changes
                        </button>
                        <button onClick={() => setEditingLib(null)} className="btn-secondary text-xs py-2 px-4">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-heading font-semibold text-white text-sm">{lib.name}</span>
                          <span className="text-xs font-mono bg-white/10 text-white/70 px-2 py-0.5 rounded capitalize">
                            {lib.type}
                          </span>
                        </div>
                        <div className="space-y-1">
                          {lib.remotePaths.map((p, idx) => (
                            <div key={idx} className="flex items-center gap-1.5 text-xs font-mono text-subtle truncate max-w-lg">
                              {isLocalPath(p) ? (
                                <span className="flex items-center gap-1 text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0">
                                  <HardDrive size={10} /> Local
                                </span>
                              ) : (
                                <span className="flex items-center gap-1 text-sky-400 bg-sky-500/10 px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0">
                                  <Cloud size={10} /> Remote
                                </span>
                              )}
                              <span className="truncate">{p}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={async () => {
                            await scanLibrary(lib, { tmdb: tmdbApiKey, theporndb: thePornDbApiKey });
                          }}
                          disabled={syncState.syncing || scanState.status === "scanning"}
                          className="p-2 rounded hover:bg-white/10 text-white/70 hover:text-accent transition-colors disabled:opacity-40"
                          title={`Scan "${lib.name}" now`}
                        >
                          <RefreshCw
                            size={16}
                            className={scanState.status === "scanning" && scanState.currentLibrary === lib.name ? "animate-spin text-accent" : ""}
                          />
                        </button>
                        <button
                          onClick={() => setEditingLib({ ...lib, remotePaths: [...lib.remotePaths] })}
                          className="p-2 rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button
                          onClick={() => removeLibrary(lib.id)}
                          className="p-2 rounded hover:bg-danger/20 text-danger transition-colors"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Storage Remotes in rclone.conf */}
            <div className="mt-8 pt-6 border-t border-border">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
                <div>
                  <h3 className="text-white font-heading font-semibold text-sm">Storage Remotes (rclone.conf)</h3>
                  <p className="text-subtle font-body text-xs mt-0.5">Remotes configured in your rclone config available for library mappings.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleReloadRemotes}
                    className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5"
                    title="Reload remotes from active config file"
                  >
                    <RefreshCw size={12} /> Reload
                  </button>
                  <button
                    onClick={handleBrowseRcloneConfig}
                    className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5"
                    title="Select a different rclone.conf file"
                  >
                    <Folder size={12} /> Change Config
                  </button>
                  <button
                    onClick={async () => {
                      let current = useAppStore.getState().rcloneConfigContent || "";
                      if (!current) {
                        current = await invoke<string>("load_rclone_config_content").catch(() => "");
                      }
                      setPasteConfigText(current);
                      setShowPasteConfigModal(true);
                    }}
                    className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5"
                    title="Paste or edit rclone.conf text directly"
                  >
                    <FileText size={12} /> Paste / Edit Config
                  </button>
                  <button
                    onClick={() => {
                      setTelegramError(null);
                      setShowTelegramModal(true);
                    }}
                    className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5 text-accent"
                  >
                    <Plus size={12} /> Add WebDAV / Telegram
                  </button>
                  {!isAndroidRuntime() && (
                    <button
                      type="button"
                      onClick={() => setShowVirtualRemoteModal(true)}
                      className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1.5 text-accent"
                    >
                      <Plus size={12} /> Union / Combine Pool
                    </button>
                  )}
                </div>
              </div>
              {showVirtualRemoteModal && (
                <VirtualRemoteCreateModal onClose={() => setShowVirtualRemoteModal(false)} />
              )}

              {/* Active Config Path Banner */}
              <div className="flex items-center justify-between gap-3 px-3 py-2 bg-panel/60 border border-border/80 rounded-lg text-xs mb-3 font-mono">
                <span className="text-subtle shrink-0">Config File:</span>
                <span className="text-bright truncate flex-1 font-semibold" title={rcloneConfigPath || "Default auto-discovery"}>
                  {rcloneConfigPath || "Default (~/rclone (2).conf or ~/.config/rclone/rclone.conf)"}
                </span>
                <span className="text-[11px] text-accent bg-accent/10 px-2 py-0.5 rounded font-sans shrink-0">
                  {remotes.length} remote{remotes.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {remotes.map((r) => (
                  <div key={r.name} className="p-3 rounded-lg bg-panel border border-border flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="p-1.5 rounded-md bg-accent/15 text-accent shrink-0">
                        <HardDrive size={14} />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-white text-xs truncate">{r.name}:</p>
                        <p className="text-[10px] uppercase font-mono text-subtle truncate">{r.type}</p>
                      </div>
                    </div>
                    <span className="text-[10px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-1.5 py-0.5 rounded font-mono">
                      Active
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {section === "external_servers" && (
          <ExternalServersSettingsSection />
        )}

        {/* API Keys */}
        {section === "apikeys" && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="font-display text-3xl text-bright tracking-wide">API KEYS</h2>
              <p className="text-subtle font-body text-sm mt-1">Configure metadata providers and API credentials.</p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                  TMDB API Key (Optional Fallback)
                </label>
                <input
                  type="password"
                  value={tmdbInput}
                  onChange={(e) => setTmdbInput(e.target.value)}
                  placeholder="eyJhbGciOiJIUzI1NiJ9..."
                  className="input-field font-mono text-xs"
                />
                <p className="text-xs text-subtle mt-1">
                  Stremio Cinemeta provides free movie and TV metadata automatically. TMDB is only queried if Cinemeta has no match.
                </p>
              </div>

              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">ThePornDB API Token</label>
                <input
                  type="password"
                  value={pornDbInput}
                  onChange={(e) => setPornDbInput(e.target.value)}
                  placeholder="theporndb_api_token"
                  className="input-field font-mono text-xs"
                />
              </div>

              <button onClick={handleSaveApiKeys} className="btn-primary text-xs py-2 px-5 flex items-center gap-1.5">
                {savedApiKeys ? <Check size={16} /> : <Save size={16} />}
                {savedApiKeys ? "Saved!" : "Save Credentials"}
              </button>
            </div>

            {/* Stash-Box Providers & Experimental Visual pHash */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-white">Stash-Box Providers</h3>
                  <p className="text-xs text-subtle mt-0.5">
                    GraphQL fingerprint &amp; scene lookup (StashDB preset: https://stashdb.org/graphql).
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stashEnabled}
                    onChange={(e) => setStashEnabled(e.target.checked)}
                    className="rounded border-border text-accent focus:ring-0"
                  />
                  <span className="text-xs text-white font-semibold">Enable</span>
                </label>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-subtle block mb-1">GraphQL Endpoint</label>
                  <input
                    type="text"
                    value={stashEndpoint}
                    onChange={(e) => setStashEndpoint(e.target.value)}
                    placeholder="https://stashdb.org/graphql"
                    className="input-field font-mono text-xs w-full"
                  />
                </div>
                <div>
                  <label className="text-xs text-subtle block mb-1">ApiKey</label>
                  <input
                    type="password"
                    value={stashApiKey}
                    onChange={(e) => setStashApiKey(e.target.value)}
                    placeholder="Stash-Box API Key"
                    className="input-field font-mono text-xs w-full"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(experimentalPhashEnabled)}
                  onChange={(e) => setExperimentalPhashEnabled(e.target.checked)}
                  className="rounded border-border text-accent focus:ring-0"
                />
                <span className="text-xs text-subtle">
                  Experimental: Enable Visual pHash (25-frame montage) in Fingerprint Modal
                </span>
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setStashBoxProviders([
                      {
                        id: "stashdb",
                        name: "StashDB",
                        endpoint: stashEndpoint.trim() || "https://stashdb.org/graphql",
                        apiKey: stashApiKey.trim(),
                        enabled: stashEnabled,
                      },
                    ]);
                    useToastStore.getState().addToast("Saved Stash-Box provider settings", "success");
                  }}
                  className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                >
                  <Save size={14} /> Save Stash-Box
                </button>
                <button
                  type="button"
                  disabled={testingStash || !stashEndpoint.trim()}
                  onClick={async () => {
                    setTestingStash(true);
                    try {
                      const r = await testStashBoxConnection({
                        id: "stashdb",
                        name: "StashDB",
                        endpoint: stashEndpoint.trim(),
                        apiKey: stashApiKey.trim(),
                        enabled: stashEnabled,
                      });
                      useToastStore.getState().addToast(r.message, r.ok ? "success" : "error");
                    } catch (e: any) {
                      useToastStore.getState().addToast(`Connection failed: ${e?.message || e}`, "error");
                    } finally {
                      setTestingStash(false);
                    }
                  }}
                  className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                >
                  {testingStash ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Test Connection
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Playback */}
        {section === "playback" && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="font-display text-3xl text-bright tracking-wide">PLAYBACK</h2>
              <p className="text-subtle font-body text-sm mt-1">
                Choose the video engine and which audio track to prefer.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                  Preferred audio language
                </label>
                <select
                  value={playback.preferredAudioLanguage}
                  onChange={(e) => setPlaybackSettings({ preferredAudioLanguage: e.target.value })}
                  className="input-field text-sm"
                >
                  <option value="eng">English</option>
                  <option value="jpn">Japanese</option>
                  <option value="spa">Spanish</option>
                  <option value="fra">French</option>
                  <option value="deu">German</option>
                  <option value="">No preference (use file default)</option>
                </select>
                <p className="text-xs text-subtle mt-1">
                  Dual-audio files automatically select this track instead of whichever the
                  file lists first.
                </p>
              </div>

              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                  Preferred subtitle language
                </label>
                <select
                  value={playback.preferredSubtitleLanguage}
                  onChange={(e) => setPlaybackSettings({ preferredSubtitleLanguage: e.target.value })}
                  className="input-field text-sm"
                >
                  <option value="">Off</option>
                  <option value="eng">English</option>
                  <option value="jpn">Japanese</option>
                  <option value="spa">Spanish</option>
                  <option value="fra">French</option>
                  <option value="deu">German</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                  Video engine
                </label>
                <select
                  value={playback.videoEngine}
                  onChange={(e) =>
                    setPlaybackSettings({ videoEngine: e.target.value as typeof playback.videoEngine })
                  }
                  className="input-field text-sm"
                >
                  <option value="auto">Automatic (recommended)</option>
                  <option value="vlc">Always use VLC</option>
                  <option value="html5">Always use the built-in player</option>
                </select>
                <p className="text-xs text-subtle mt-1">
                  The built-in player is smoother but cannot switch audio tracks. Automatic
                  uses it for single-audio files and hands anything with multiple audio tracks
                  to VLC, so the track menu is always available when it is needed.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Rclone & Streaming Cache */}
        {section === "rclone" && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="font-display text-3xl text-bright tracking-wide">RCLONE &amp; STREAMING CACHE</h2>
              <p className="text-subtle font-body text-sm mt-1">
                Configure directory caching, chunk sizes, and rate limiting to prevent API bans on strict cloud remotes (like OpenDrive).
              </p>
            </div>

            {/* Provider Guidelines / IP Blacklist Notice */}
            <div className="bg-panel border border-border/80 rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-accent font-heading font-semibold text-sm">
                <Shield size={16} /> OpenDrive &amp; Strict Provider Protection
              </div>
              <p className="text-xs text-subtle leading-relaxed">
                Cloud providers like OpenDrive enforce aggressive API rate limits. Rapid burst requests during directory traversal or stream start can result in temporary IP blacklists.
              </p>
              <ul className="text-xs text-text/80 space-y-1 list-disc list-inside">
                <li><strong className="text-white">Long Directory Cache (72h):</strong> Caches folder structures for days so seeking, browsing, and replaying files make zero API requests.</li>
                <li><strong className="text-white">VFS Cache (Full):</strong> Writes downloaded stream chunks directly to disk for instantaneous seeking and replay.</li>
                <li><strong className="text-white">Rate Limiting (4 req/s):</strong> Enforces a strict transaction speed limit across all listing, streaming, and scanning commands.</li>
                <li><strong className="text-white">Avoid Full Rescans:</strong> Once media is scanned, it is cached permanently in your local database. Use Cloud Explorer folder matching for new content.</li>
              </ul>
            </div>

            <div className="space-y-4">
              {/* Rate Limiting */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                    Transaction Limit (--tpslimit)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    step="0.5"
                    value={localRclone.tpsLimit}
                    onChange={(e) =>
                      setLocalRclone({
                        ...localRclone,
                        tpsLimit: Math.max(0.5, parseFloat(e.target.value) || 4),
                      })
                    }
                    className="input-field text-sm font-mono w-full"
                  />
                  <p className="text-xs text-subtle mt-1">
                    Max transactions/sec sent to cloud remotes (recommended: 2 - 4).
                  </p>
                </div>

                <div>
                  <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                    Burst Transactions (--tpslimit-burst)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={localRclone.tpsLimitBurst}
                    onChange={(e) =>
                      setLocalRclone({
                        ...localRclone,
                        tpsLimitBurst: Math.max(1, parseInt(e.target.value) || 2),
                      })
                    }
                    className="input-field text-sm font-mono w-full"
                  />
                  <p className="text-xs text-subtle mt-1">
                    Permitted burst size for initial connections (recommended: 2).
                  </p>
                </div>
              </div>

              {/* Dir Cache Time */}
              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                  Directory Cache Duration (--dir-cache-time)
                </label>
                <select
                  value={localRclone.dirCacheTime}
                  onChange={(e) => setLocalRclone({ ...localRclone, dirCacheTime: e.target.value })}
                  className="input-field text-sm w-full"
                >
                  <option value="24h">24h (1 Day)</option>
                  <option value="72h">72h (3 Days — Recommended)</option>
                  <option value="168h">168h (1 Week)</option>
                  <option value="720h">720h (1 Month)</option>
                </select>
                <p className="text-xs text-subtle mt-1">
                  How long rclone keeps remote directory structures cached in memory.
                </p>
              </div>

              {/* VFS Cache Mode */}
              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                  VFS Cache Mode (--vfs-cache-mode)
                </label>
                <select
                  value={localRclone.vfsCacheMode}
                  onChange={(e) => setLocalRclone({ ...localRclone, vfsCacheMode: e.target.value })}
                  className="input-field text-sm w-full"
                >
                  <option value="full">full (Full disk caching — Recommended for seeking &amp; stability)</option>
                  <option value="writes">writes (Cache writes only)</option>
                  <option value="minimal">minimal (Minimal memory buffer)</option>
                  <option value="off">off (No VFS caching)</option>
                </select>
                <p className="text-xs text-subtle mt-1">
                  Caching media segments locally on disk eliminates repeat cloud reads during seeking.
                </p>
              </div>

              {/* Chunk Sizes */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                    Read Chunk Size (--vfs-read-chunk-size)
                  </label>
                  <select
                    value={localRclone.vfsReadChunkSize}
                    onChange={(e) => setLocalRclone({ ...localRclone, vfsReadChunkSize: e.target.value })}
                    className="input-field text-sm w-full font-mono"
                  >
                    <option value="8M">8M</option>
                    <option value="16M">16M (Recommended)</option>
                    <option value="32M">32M</option>
                    <option value="64M">64M</option>
                  </select>
                  <p className="text-xs text-subtle mt-1">
                    Initial chunk size downloaded at playback start.
                  </p>
                </div>

                <div>
                  <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                    Chunk Size Limit (--vfs-read-chunk-size-limit)
                  </label>
                  <select
                    value={localRclone.vfsReadChunkSizeLimit}
                    onChange={(e) => setLocalRclone({ ...localRclone, vfsReadChunkSizeLimit: e.target.value })}
                    className="input-field text-sm w-full font-mono"
                  >
                    <option value="32M">32M</option>
                    <option value="64M">64M (Recommended)</option>
                    <option value="128M">128M</option>
                    <option value="256M">256M</option>
                    <option value="off">off (Unlimited doubling)</option>
                  </select>
                  <p className="text-xs text-subtle mt-1">
                    Maximum chunk size doubling during continuous playback.
                  </p>
                </div>
              </div>

              {/* Bandwidth Limit & Soft-Delete App Trash (Desktop Only) */}
              {!isAndroidRuntime() && (
                <div className="space-y-4 pt-2 border-t border-border/60">
                  <div>
                    <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                      Background Bandwidth Limit / Timetable (--bwlimit)
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={localRclone.bwLimit || ""}
                        onChange={(e) =>
                          setLocalRclone({
                            ...localRclone,
                            bwLimit: e.target.value || null,
                          })
                        }
                        placeholder="e.g. 10M or 08:00,5M 23:00,off (leave blank for unlimited)"
                        className="input-field text-sm font-mono flex-1"
                      />
                      <button
                        type="button"
                        onClick={() => setLocalRclone({ ...localRclone, bwLimit: "5M" })}
                        className="btn-secondary text-xs px-2.5"
                      >
                        5M Safe
                      </button>
                      <button
                        type="button"
                        onClick={() => setLocalRclone({ ...localRclone, bwLimit: "08:00,5M 23:00,off" })}
                        className="btn-secondary text-xs px-2.5"
                      >
                        Day/Night
                      </button>
                      <button
                        type="button"
                        onClick={() => setLocalRclone({ ...localRclone, bwLimit: null })}
                        className="btn-secondary text-xs px-2.5"
                      >
                        Unlimited
                      </button>
                    </div>
                    <p className="text-xs text-subtle mt-1">
                      Applies per background copy/move/bisync process (never throttles live media playback).
                    </p>
                  </div>

                  <div className="bg-panel border border-border rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="pr-4">
                        <p className="font-heading font-semibold text-white text-sm">
                          Soft-Delete to App Trash Folder (moveto)
                        </p>
                        <p className="text-subtle font-body text-xs mt-1">
                          Moves deleted Cloud Explorer items into a timestamped trash folder on the same remote instead of permanent deletion. Excluded from library scans.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setLocalRclone({
                            ...localRclone,
                            softDeleteEnabled: !localRclone.softDeleteEnabled,
                          })
                        }
                        className={`w-12 h-6 flex items-center rounded-full p-1 transition-colors duration-200 shrink-0 ${
                          localRclone.softDeleteEnabled ? "bg-accent" : "bg-border"
                        }`}
                      >
                        <div
                          className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-200 ${
                            localRclone.softDeleteEnabled ? "translate-x-6" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </div>
                    {localRclone.softDeleteEnabled && (
                      <div>
                        <label className="text-xs text-subtle block mb-1">
                          App Trash Folder Name (letters, numbers, ., _, - only; changing this leaves older trash in the previous folder)
                        </label>
                        <input
                          type="text"
                          value={localRclone.softDeleteTrashDir || ".rcloneflix_trash"}
                          onChange={(e) =>
                            setLocalRclone({
                              ...localRclone,
                              softDeleteTrashDir: e.target.value,
                            })
                          }
                          className="input-field text-xs font-mono w-full"
                        />
                        {Boolean(localRclone.softDeleteTrashDir?.trim()) &&
                          !isValidSoftDeleteTrashDir(localRclone.softDeleteTrashDir || "") && (
                            <p className="text-[11px] text-rose-400 mt-1">
                              Invalid folder name: use only letters, numbers, &apos;.&apos;, &apos;_&apos;, and &apos;-&apos; (not &apos;.&apos; or &apos;..&apos;).
                            </p>
                          )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Rescan Safeguards */}
              <div className="bg-panel border border-border rounded-xl p-4 flex items-center justify-between">
                <div className="pr-4">
                  <p className="font-heading font-semibold text-white text-sm">
                    Automatic Full Library Rescan on Startup
                  </p>
                  <p className="text-subtle font-body text-xs mt-1">
                    Keep this OFF when using cloud remotes like OpenDrive. When disabled, RcloneFlix loads your media instantaneously from your local database without triggering cloud API limits.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setLocalRclone({
                      ...localRclone,
                      autoScanOnStartup: !localRclone.autoScanOnStartup,
                    })
                  }
                  className={`w-12 h-6 flex items-center rounded-full p-1 transition-colors duration-200 shrink-0 ${
                    localRclone.autoScanOnStartup ? "bg-accent" : "bg-border"
                  }`}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-200 ${
                      localRclone.autoScanOnStartup ? "translate-x-6" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={handleSaveRcloneSettings}
                  className="btn-primary text-xs py-2 px-5 flex items-center gap-1.5"
                >
                  {savedRclone ? <Check size={16} /> : <Save size={16} />}
                  {savedRclone ? "Settings Saved!" : "Save Rclone Settings"}
                </button>
                <button
                  onClick={() => setLocalRclone(defaultRcloneSettings)}
                  className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5"
                >
                  <RefreshCw size={14} /> Reset Defaults
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Adult & Privacy */}
        {section === "adult" && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="font-display text-3xl text-bright tracking-wide">ADULT &amp; PRIVACY</h2>
              <p className="text-subtle font-body text-sm mt-1">
                Lock the Adult library behind a PIN and hide it from the sidebar.
              </p>
            </div>

            <div className="bg-panel border border-border rounded-xl p-4 flex items-center justify-between">
              <div className="pr-4">
                <p className="font-heading font-semibold text-white text-sm flex items-center gap-2">
                  {adultSettings.pinEnabled ? (
                    <>
                      <Lock size={14} className="text-teal" /> PIN protection is on
                    </>
                  ) : (
                    <>
                      <EyeOff size={14} className="text-subtle" /> No PIN set
                    </>
                  )}
                </p>
                <p className="text-subtle font-body text-xs mt-1">
                  {adultSettings.pinEnabled
                    ? `${adultSettings.pinLength}-digit PIN required to open the Adult library.`
                    : "The Adult library opens without a prompt."}
                </p>
              </div>
              {adultSettings.pinEnabled && (
                <button onClick={handleClearPin} className="btn-secondary text-xs py-1.5 px-3 text-danger border-danger/30 flex-shrink-0">
                  Remove PIN
                </button>
              )}
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                  {adultSettings.pinEnabled ? "New PIN" : "Set PIN"} (4–6 digits)
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={pinInput}
                  onChange={(e) => setPinInput(e.target.value.replace(/\D/g, ""))}
                  placeholder="••••"
                  className="input-field font-mono text-sm tracking-widest"
                />
              </div>
              <div>
                <label className="text-sm font-heading font-medium text-white mb-1.5 block">Confirm PIN</label>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={6}
                  value={pinConfirm}
                  onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ""))}
                  placeholder="••••"
                  className="input-field font-mono text-sm tracking-widest"
                />
              </div>
              <button onClick={handleSetPin} className="btn-primary text-xs py-2 px-5 flex items-center gap-1.5">
                <Lock size={14} />
                {adultSettings.pinEnabled ? "Change PIN" : "Enable PIN"}
              </button>
            </div>

            <div className="bg-panel border border-border rounded-xl p-4 flex items-center justify-between">
              <div className="pr-4">
                <p className="font-heading font-semibold text-white text-sm">Hide from sidebar</p>
                <p className="text-subtle font-body text-xs mt-1">
                  Removes the Adult entry from navigation and the home screen rows.
                </p>
              </div>
              <button
                onClick={() => setAdultHidden(!adultSettings.hidden)}
                role="switch"
                aria-checked={adultSettings.hidden}
                className={`w-12 h-6 rounded-full flex-shrink-0 transition-colors relative ${
                  adultSettings.hidden ? "bg-accent" : "bg-muted"
                }`}
              >
                <span
                  className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${
                    adultSettings.hidden ? "left-7" : "left-1"
                  }`}
                />
              </button>
            </div>

            <div className="flex items-start gap-2 text-xs text-subtle font-body bg-white/5 border border-white/10 rounded-lg p-3">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5 text-accent" />
              <span>
                This is a casual deterrent, not real access control — the PIN hash is stored on
                this machine and anyone with filesystem access can clear it. Don't rely on it to
                protect sensitive material.
              </span>
            </div>
          </div>
        )}

        {/* Diagnostics */}
        {section === "diagnostics" && (
          <div className="max-w-3xl space-y-5">
            <div>
              <h2 className="font-display text-3xl text-bright tracking-wide">DIAGNOSTICS</h2>
              <p className="text-subtle font-body text-sm mt-1">
                Everything the app does is written here — attach this when reporting a problem.
              </p>
            </div>

            <DiagnosticsQolCards />

            <div className="bg-panel border border-border rounded-xl p-4">
              <p className="text-subtle font-body text-[10px] uppercase tracking-wider mb-1">Log file</p>
              <p className="text-text font-mono text-xs break-all">{logPath || "…"}</p>
            </div>

            <div className="flex gap-2">
              <button onClick={refreshLog} className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5">
                <RefreshCw size={14} /> Refresh
              </button>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(logTail).then(
                    () => useToastStore.getState().addToast("Log copied to clipboard", "success"),
                    () => useToastStore.getState().addToast("Could not copy log", "error")
                  );
                }}
                className="btn-secondary text-xs py-2 px-4"
              >
                Copy log
              </button>
            </div>

            <pre className="bg-void border border-border rounded-xl p-4 text-[11px] font-mono text-subtle overflow-auto max-h-[26rem] whitespace-pre-wrap break-all">
              {logTail || "No log entries yet."}
            </pre>
          </div>
        )}

        {/* Sync */}
        {section === "sync" && (
          <div className="max-w-xl space-y-6">
            <div>
              <h2 className="font-display text-3xl text-bright tracking-wide">BACKUP & RESTORE</h2>
              <p className="text-subtle font-body text-sm mt-1">
                Back up your library and watch progress to any rclone remote, and pick it
                back up on another machine. No sign-in needed — it uses the same rclone
                config you already loaded.
              </p>
            </div>

            <div>
              <label className="text-sm font-heading font-medium text-white mb-1.5 block">
                Backup folder
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={backupFolder}
                  onChange={(e) => setBackupFolder(e.target.value)}
                  placeholder="gdrive:RcloneFlix"
                  className="input-field text-sm font-mono flex-1"
                />
                <button
                  onClick={() => setShowBackupBrowser("folder")}
                  className="btn-secondary text-xs py-2 px-3 flex-shrink-0"
                >
                  Browse
                </button>
              </div>
              <p className="text-xs text-subtle mt-1">
                A single <span className="font-mono">{BACKUP_FILE}</span> is written here and
                overwritten on each backup.
              </p>
            </div>

            <div>
              <label className="text-sm font-heading font-medium text-white mb-1.5 flex items-center justify-between">
                <span>Backup Passphrase (Optional AES-256-GCM Encryption)</span>
                <span className="text-[10px] font-mono text-accent">Zero-Knowledge</span>
              </label>
              <div className="relative">
                <input
                  type={showPassphrase ? "text" : "password"}
                  value={backupPassphrase}
                  onChange={(e) => setBackupPassphrase(e.target.value)}
                  placeholder="Enter passphrase to encrypt on backup or decrypt on restore"
                  className="input-field text-sm font-mono w-full pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassphrase(!showPassphrase)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 hover:text-white"
                >
                  {showPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <p className="text-xs text-subtle mt-1">
                If specified, sensitive API tokens, rclone configs, and library paths are encrypted with PBKDF2 + AES-256-GCM before writing to the cloud.
              </p>
            </div>

            {syncMsg && <p className="text-xs font-mono text-accent">{syncMsg}</p>}
            {syncState.error && (
              <p className="text-xs font-mono text-danger bg-danger/10 p-3 rounded-lg break-all">
                {syncState.error}
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleRemoteBackup}
                disabled={syncState.syncing || !backupFolder.trim()}
                className="btn-primary text-xs py-2.5 px-4 flex items-center gap-2 disabled:opacity-50"
              >
                <Cloud size={16} />
                {syncState.syncing ? "Working…" : "Back up now"}
              </button>
              <button
                onClick={() => setShowBackupBrowser("file")}
                disabled={syncState.syncing}
                className="btn-secondary text-xs py-2.5 px-4 flex items-center gap-2 disabled:opacity-50"
              >
                <RefreshCw size={16} /> Restore from a backup…
              </button>
            </div>

            {syncState.lastSyncAt && (
              <p className="text-xs text-subtle font-body">
                Last synced {new Date(syncState.lastSyncAt).toLocaleString()}
              </p>
            )}

            <div className="flex items-start gap-2 text-xs text-subtle font-body bg-white/5 border border-white/10 rounded-lg p-3">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5 text-accent" />
              <span>
                Restoring merges rather than replaces: media you don't have is added, and
                watch progress keeps whichever side was watched most recently — so two
                machines converge instead of the last one to sync overwriting the other.
              </span>
            </div>

            <div className="pt-4 border-t border-border space-y-4">
              <div>
                <p className="text-subtle font-body text-[10px] uppercase tracking-wider mb-1.5">
                  Local Storage Cache Cap
                </p>
                <div className="flex items-center justify-between">
                  <p className="text-text font-body text-xs">
                    Limit local disk usage for cached covers and photo previews.
                  </p>
                  <select
                    value={localStorageCapMb || 200}
                    onChange={(e) => setLocalStorageCapMb(Number(e.target.value))}
                    className="px-2.5 py-1.5 rounded-lg bg-panel border border-border text-bright text-xs font-mono focus:outline-none focus:border-accent"
                  >
                    <option value={100}>100 MB</option>
                    <option value={200}>200 MB (Default)</option>
                    <option value={500}>500 MB</option>
                    <option value={1000}>1,000 MB (1 GB)</option>
                    <option value={2000}>2,000 MB (2 GB)</option>
                  </select>
                </div>
              </div>

              <div className="pt-3 border-t border-border/40">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-text font-body text-xs font-medium">
                      Remote Cover Art Mirroring
                    </p>
                    <p className="text-subtle font-body text-[11px] mt-0.5">
                      Mirror covers to {remotes[0]?.name ? `${remotes[0].name}:.artwork/` : "cloud remote"} to survive CDN 404s.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setArtworkRemoteMirrorEnabled(!artworkRemoteMirrorEnabled)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      artworkRemoteMirrorEnabled ? "bg-accent" : "bg-panel border border-border"
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bright transition-transform ${
                        artworkRemoteMirrorEnabled ? "translate-x-4" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-border/40">
                <p className="text-subtle font-body text-[10px] uppercase tracking-wider mb-2">
                  Poster cache
                </p>
                <div className="flex items-center justify-between">
                  <p className="text-text font-body text-xs">
                    {artStats
                      ? `${artStats.files} images · ${(artStats.bytes / 1024 / 1024).toFixed(1)} MB`
                      : "…"}
                  </p>
                  <button
                    onClick={async () => {
                      await clearArtworkCache();
                      setArtStats(await artworkCacheStats());
                      useToastStore.getState().addToast("Poster cache cleared", "info");
                    }}
                    className="btn-secondary text-xs py-1 px-3"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-border/40">
                <p className="text-subtle font-body text-[10px] uppercase tracking-wider mb-2">
                  Photo disk cache
                </p>
                <div className="flex items-center justify-between">
                  <p className="text-text font-body text-xs">
                    {photoStats
                      ? `${photoStats.files} items · ${(photoStats.bytes / 1024 / 1024).toFixed(1)} MB`
                      : "…"}
                  </p>
                  <button
                    onClick={async () => {
                      await clearVaultPhotoCache();
                      setPhotoStats(await vaultPhotoCacheStats());
                      useToastStore.getState().addToast("Photo cache cleared", "info");
                    }}
                    className="btn-secondary text-xs py-1 px-3"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {section === "passes" && (
          <div className="space-y-8 max-w-4xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="font-display text-3xl text-bright tracking-wide">
                  ACCESS PASSES (.rflix)
                </h2>
                <p className="text-subtle font-body text-sm mt-1">
                  Serverless, encrypted library sharing with scoped credentials, single-use activation, and strict expiry.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowCreatePassModal(true)}
                  className="flex items-center gap-2 px-3.5 py-2 bg-accent text-void rounded-lg font-body text-xs font-semibold hover:bg-accent-hover transition-colors shadow-accent-glow"
                >
                  <Share2 size={15} />
                  <span>Create Access Pass</span>
                </button>
                <button
                  onClick={() => setShowImportPassModal(true)}
                  className="flex items-center gap-2 px-3.5 py-2 bg-panel border border-border text-bright rounded-lg font-body text-xs font-semibold hover:bg-panel/80 transition-colors"
                >
                  <Plus size={15} />
                  <span>Import Access Pass</span>
                </button>
              </div>
            </div>

            {/* Sub-section 1: Imported Passes */}
            <div className="space-y-4">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <div>
                  <h3 className="font-display text-lg text-bright">
                    IMPORTED SHARED LIBRARIES
                  </h3>
                  <p className="font-body text-xs text-subtle">
                    Libraries shared with you by friends. Streaming is direct from their cloud.
                  </p>
                </div>
                <span className="font-mono text-xs text-subtle">
                  {libraries.filter((l) => l.isSharedPass).length} active
                </span>
              </div>

              {libraries.filter((l) => l.isSharedPass).length === 0 ? (
                <div className="p-8 text-center bg-panel/30 border border-border rounded-xl">
                  <Share2 size={32} className="mx-auto text-subtle/50 mb-2" />
                  <p className="font-body text-sm text-subtle">
                    No shared passes imported yet.
                  </p>
                  <button
                    onClick={() => setShowImportPassModal(true)}
                    className="mt-3 text-accent font-body text-xs font-semibold hover:underline"
                  >
                    Import a .rflix pass from a friend →
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {libraries
                    .filter((l) => l.isSharedPass)
                    .map((lib) => {
                      const isExpired =
                        lib.isExpired ||
                        (lib.expiresAt && Date.now() >= lib.expiresAt);

                      return (
                        <div
                          key={lib.id}
                          className={`p-4 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all ${
                            isExpired
                              ? "bg-danger/5 border-danger/30"
                              : "bg-panel/50 border-border"
                          }`}
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-display text-base text-bright">
                                {lib.name}
                              </span>
                              <span className="font-body text-[11px] px-2 py-0.5 rounded-full bg-accent/10 border border-accent/20 text-accent uppercase font-semibold">
                                {lib.type}
                              </span>
                              {isExpired ? (
                                <span className="font-body text-[11px] px-2 py-0.5 rounded-full bg-danger/20 text-danger border border-danger/30 font-semibold">
                                  Expired
                                </span>
                              ) : (
                                <span className="font-body text-[11px] px-2 py-0.5 rounded-full bg-teal/20 text-teal border border-teal/30 font-semibold">
                                  Active
                                </span>
                              )}
                            </div>
                            <div className="font-body text-xs text-subtle flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span>
                                Host:{" "}
                                <strong className="text-text font-medium">
                                  {lib.grantorLabel || "Friend"}
                                </strong>
                              </span>
                              <span>·</span>
                              <span>
                                Expires:{" "}
                                <strong className="text-text font-medium">
                                  {lib.expiresAt
                                    ? new Date(lib.expiresAt).toLocaleDateString(
                                        undefined,
                                        {
                                          month: "short",
                                          day: "numeric",
                                          year: "numeric",
                                          hour: "2-digit",
                                          minute: "2-digit",
                                        }
                                      )
                                    : "Lifetime"}
                                </strong>
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              onClick={async () => {
                                if (
                                  confirm(
                                    `Remove shared library "${lib.name}"? This will clean up scoped remotes and cached metadata.`
                                  )
                                ) {
                                  await removeSharedPass(lib.passId || lib.id);
                                  useToastStore
                                    .getState()
                                    .addToast("Shared library removed", "info");
                                }
                              }}
                              className="px-3 py-1.5 rounded-lg bg-danger/10 hover:bg-danger/20 border border-danger/30 text-danger font-body text-xs font-semibold transition-colors"
                            >
                              Remove (1-Click)
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>

            {/* Sub-section 2: Issued Passes */}
            <div className="space-y-4 pt-4">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <div>
                  <h3 className="font-display text-lg text-bright">
                    ISSUED ACCESS PASSES
                  </h3>
                  <p className="font-body text-xs text-subtle">
                    Passes you created for friends. You can revoke access at any time.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-subtle">
                    {issuedPasses?.length || 0} passes
                  </span>
                  <button
                    onClick={async () => {
                      setSyncingPasses(true);
                      await syncIssuedPasses();
                      setSyncingPasses(false);
                      useToastStore.getState().addToast("Pass statuses synchronized from cloud", "info");
                    }}
                    disabled={syncingPasses}
                    className="p-1.5 rounded-lg bg-surface/50 border border-border text-subtle hover:text-white hover:border-accent/40 transition-colors flex items-center gap-1.5 text-xs"
                    title="Sync pass claim & expiry statuses from cloud"
                  >
                    <RefreshCw size={12} className={syncingPasses ? "animate-spin text-accent" : ""} />
                    <span>Sync</span>
                  </button>
                </div>
              </div>

              {(!issuedPasses || issuedPasses.length === 0) ? (
                <div className="p-8 text-center bg-panel/30 border border-border rounded-xl">
                  <Share2 size={32} className="mx-auto text-subtle/50 mb-2" />
                  <p className="font-body text-sm text-subtle">
                    You haven't generated any access passes yet.
                  </p>
                  <button
                    onClick={() => setShowCreatePassModal(true)}
                    className="mt-3 text-accent font-body text-xs font-semibold hover:underline"
                  >
                    Create your first access pass →
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3">
                  {issuedPasses.map((pass) => {
                    const isRevoked = pass.status === "revoked";

                    return (
                      <div
                        key={pass.passId}
                        className="p-4 rounded-xl bg-panel/50 border border-border flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="font-display text-base text-bright">
                              {pass.label}
                            </span>
                            <span className="font-body text-[11px] px-2 py-0.5 rounded-full bg-accent/10 border border-accent/20 text-accent font-medium">
                              {formatDuration(pass.duration)}
                            </span>
                            {isRevoked ? (
                              <span className="font-body text-[11px] px-2 py-0.5 rounded-full bg-danger/20 text-danger border border-danger/30 font-semibold">
                                Revoked
                              </span>
                            ) : pass.status === "expired" ? (
                              <span className="font-body text-[11px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 font-semibold">
                                Expired
                              </span>
                            ) : pass.status === "claimed" ? (
                              <span className="font-body text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-semibold">
                                Claimed & Active
                              </span>
                            ) : (
                              <span className="font-body text-[11px] px-2 py-0.5 rounded-full bg-teal/20 text-teal border border-teal/30 font-medium capitalize">
                                Unclaimed
                              </span>
                            )}
                          </div>
                          <div className="font-body text-xs text-subtle flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span>
                              Created:{" "}
                              {new Date(pass.createdAt).toLocaleDateString()}
                            </span>
                            <span>·</span>
                            <span>
                              Libraries:{" "}
                              {pass.sharedLibraries.map((l) => l.name).join(", ")}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {!isRevoked && (
                            <button
                              onClick={async () => {
                                if (
                                  confirm(
                                    `Revoke access pass "${pass.label}"? Your friend's access will be severed immediately.`
                                  )
                                ) {
                                  await revokeIssuedPass(pass.passId);
                                  useToastStore
                                    .getState()
                                    .addToast("Pass revoked successfully", "info");
                                }
                              }}
                              className="px-3 py-1.5 rounded-lg bg-danger/10 hover:bg-danger/20 border border-danger/30 text-danger font-body text-xs font-semibold transition-colors"
                            >
                              Revoke Access
                            </button>
                          )}
                          <button
                            onClick={() => {
                              removeIssuedPass(pass.passId);
                              useToastStore
                                .getState()
                                .addToast("Pass record removed", "info");
                            }}
                            className="p-1.5 text-subtle hover:text-danger rounded-lg hover:bg-white/5 transition-colors"
                            title="Delete Pass Record"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {section === "trakt" && (
          <div className="max-w-2xl space-y-8">
            <div>
              <h3 className="font-display text-2xl text-bright mb-1">SIMKL SCROBBLER & DISCOVERY</h3>
              <p className="text-subtle font-body text-sm">
                100% free playback scrobbling and curated discovery shelves powered by Simkl. No VIP subscription or Plex Pass required.
              </p>
            </div>

            {/* Privacy & Anti-Phone-Home Callout */}
            <div className="p-4 rounded-xl bg-panel border border-accent/30 flex items-start gap-3.5">
              <Shield className="text-accent shrink-0 mt-0.5" size={20} />
              <div className="text-xs font-body text-text space-y-1">
                <p className="font-semibold text-bright text-sm">Zero Forced Telemetry Guarantee</p>
                <p className="text-subtle leading-relaxed">
                  Unlike Plex, RcloneFlix does <span className="text-white font-medium">not</span> phone home, inject unwanted recommendation algorithms, or track your media.
                  All scrobbling features and discovery shelves are <span className="text-accent font-medium">100% opt-in</span> and disabled by default. If disabled, zero network requests are ever made.
                </p>
              </div>
            </div>

            {/* Master Toggle */}
            <div className="p-5 rounded-xl bg-panel border border-border flex items-center justify-between">
              <div>
                <p className="text-sm font-body font-semibold text-bright">Enable Simkl Scrobbler & Discovery</p>
                <p className="text-xs text-subtle font-body mt-0.5">
                  Allows scrobbling watch progress and enabling 48-hour discovery shelves.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const curr = simklSettings?.enabled;
                  setSimklSettings({ enabled: !curr });
                  if (!curr) {
                    setTimeout(() => refreshSimklDiscovery(true), 50);
                  }
                }}
                className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  simklSettings?.enabled ? "bg-accent" : "bg-white/10"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    simklSettings?.enabled ? "translate-x-5 bg-void" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {simklSettings?.enabled && (
              <div className="space-y-6">
                {/* Simkl Connection Box */}
                <div className="p-5 rounded-xl bg-panel border border-border space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-body font-semibold text-bright">Simkl Fast Connect</h4>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/20 text-accent font-mono font-medium">1-Click PIN Auth</span>
                      </div>
                      <p className="text-xs text-subtle font-body mt-0.5">
                        {simklSettings?.accessToken
                          ? "Connected to Simkl. Watch progress scrobbling is active."
                          : "Pair your Simkl account to automatically scrobble watched movies and TV episodes."}
                      </p>
                    </div>

                    {simklSettings?.accessToken ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-2.5 py-1 rounded bg-green-500/20 text-green-400 font-medium flex items-center gap-1.5">
                          <Check size={13} /> Connected
                        </span>
                        <button
                          type="button"
                          onClick={handleDisconnectSimkl}
                          className="btn-secondary text-xs py-1 px-2.5 text-subtle hover:text-red-400"
                        >
                          Disconnect
                        </button>
                      </div>
                    ) : (
                      !simklPinState && (
                        <button
                          type="button"
                          onClick={handleStartSimklPin}
                          disabled={isPinRequesting}
                          className="btn-accent text-xs py-1.5 px-3 flex items-center gap-1.5 shrink-0"
                        >
                          {isPinRequesting ? <Loader2 size={13} className="animate-spin" /> : <Key size={13} />}
                          <span>{isPinRequesting ? "Connecting…" : "Get Simkl PIN"}</span>
                        </button>
                      )
                    )}
                  </div>

                  {/* Simkl Client ID Field */}
                  <div className="p-4 rounded-lg bg-surface/60 border border-border/80 space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                      <label className="text-xs font-semibold text-text font-body">
                        Simkl App Client ID:
                      </label>
                      <a
                        href="https://simkl.com/settings/developer/app/new/"
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-accent hover:underline flex items-center gap-1 font-medium"
                      >
                        <span>Create free Simkl App (10 sec)</span>
                        <ExternalLink size={10} />
                      </a>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={traktClientIdInput}
                        onChange={(e) => {
                          const val = e.target.value;
                          setTraktClientIdInput(val);
                          setSimklSettings({ clientId: val.trim() });
                        }}
                        placeholder="Paste your Simkl Client ID here"
                        className="input-field text-xs py-1.5 flex-1 font-mono"
                      />
                    </div>
                    <p className="text-[11px] text-subtle font-body leading-relaxed">
                      To get a Client ID: Open Simkl Developer settings, name your app anything (e.g. "RcloneFlix"), select App Type <span className="text-accent font-medium">"Native / TV / Other"</span>, set Redirect URI to <span className="font-mono text-white/80">urn:ietf:wg:oauth:2.0:oob</span>, copy the Client ID and paste it here.
                    </p>
                  </div>

                  {simklPinState && (
                    <div className="p-4 rounded-lg bg-black/40 border border-accent/40 space-y-3 font-body">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-text font-medium">1. Open Simkl Authorization:</span>
                        <a
                          href={simklPinState.verification_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-accent hover:underline flex items-center gap-1 font-medium"
                        >
                          <span>{simklPinState.verification_url}</span>
                          <ExternalLink size={12} />
                        </a>
                      </div>
                      <div className="flex items-center justify-between bg-surface/80 p-3 rounded border border-border">
                        <span className="text-xs text-subtle">2. Enter this code on Simkl:</span>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xl font-bold text-accent tracking-widest px-3 py-1 rounded bg-black/60 border border-accent/30">
                            {simklPinState.user_code}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(simklPinState.user_code);
                              useToastStore.getState().addToast("Code copied to clipboard!", "success");
                            }}
                            className="btn-secondary text-xs py-1.5 px-2.5 flex items-center gap-1"
                          >
                            <Copy size={12} />
                            <span>Copy</span>
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <div className="flex items-center gap-2 text-xs text-subtle">
                          <Loader2 size={13} className="animate-spin text-accent" />
                          <span>Waiting for authorization on Simkl…</span>
                        </div>
                        <button
                          type="button"
                          onClick={handleCancelSimklPin}
                          className="btn-secondary text-xs py-1 px-2.5 text-subtle hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Manual Token Option */}
                  {!simklSettings?.accessToken && (
                    <div className="pt-2 border-t border-border/50">
                      <details className="text-xs font-body group">
                        <summary className="cursor-pointer text-subtle hover:text-accent font-medium py-1 transition-colors select-none">
                          Or enter Simkl Access Token manually
                        </summary>
                        <div className="pt-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <input
                              type="password"
                              value={traktTokenInput}
                              onChange={(e) => setTraktTokenInput(e.target.value)}
                              placeholder="Paste Simkl Access Token"
                              className="input-field text-xs py-1.5 flex-1 font-mono"
                            />
                            <button
                              type="button"
                              onClick={handleSaveTraktCredentials}
                              className="btn-accent text-xs py-1.5 px-3"
                            >
                              Connect Token
                            </button>
                          </div>
                        </div>
                      </details>
                    </div>
                  )}
                </div>

                {/* Sub-features: Scrobbler & Discovery */}
                <div className="p-5 rounded-xl bg-panel border border-border space-y-5">
                  <h4 className="text-sm font-body font-semibold text-bright">Features</h4>

                  {/* Scrobbler Toggle */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-body font-medium text-text">Playback Scrobbler</p>
                      <p className="text-xs text-subtle font-body mt-0.5">
                        Automatically report movie and TV episode watch states to your Simkl account.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setSimklSettings({ scrobbleEnabled: !simklSettings?.scrobbleEnabled })
                      }
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        simklSettings?.scrobbleEnabled ? "bg-accent" : "bg-white/10"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          simklSettings?.scrobbleEnabled ? "translate-x-5 bg-void" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {/* 48-Hour Discovery Shelves Toggle */}
                  <div className="flex items-center justify-between border-t border-border pt-4">
                    <div>
                      <p className="text-sm font-body font-medium text-text">
                        48-Hour Discovery Shelves on Home
                      </p>
                      <p className="text-xs text-subtle font-body mt-0.5">
                        Adds Trending movies and TV shows from Simkl's public CDN to your Home page without consuming rate limits.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const nextVal = !simklSettings?.discoveryShelvesEnabled;
                        setSimklSettings({
                          discoveryShelvesEnabled: nextVal,
                        });
                        if (nextVal) {
                          setTimeout(() => {
                            handleRefreshTraktDiscoveryNow();
                          }, 50);
                        }
                      }}
                      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                        simklSettings?.discoveryShelvesEnabled ? "bg-accent" : "bg-white/10"
                      }`}
                    >
                      <span
                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                          simklSettings?.discoveryShelvesEnabled
                            ? "translate-x-5 bg-void"
                            : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>

                  {/* Manual Refresh Discovery Button */}
                  {simklSettings?.discoveryShelvesEnabled && (
                    <div className="pt-2 flex items-center justify-between border-t border-border">
                      <span className="text-xs text-subtle font-body">
                        Last refreshed:{" "}
                        {simklSettings?.lastDiscoveryFetchAt
                          ? new Date(simklSettings.lastDiscoveryFetchAt).toLocaleString()
                          : "Never"}
                      </span>
                      <button
                        onClick={handleRefreshTraktDiscoveryNow}
                        disabled={refreshingTrakt}
                        className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <RefreshCw size={13} className={refreshingTrakt ? "animate-spin text-accent" : ""} />
                        {refreshingTrakt ? "Refreshing…" : "Refresh Discovery Now"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Cloud Transcoder (Kaggle) */}
        {section === "transcoder" && (
          <div className="max-w-2xl space-y-6">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
                  <Zap size={18} />
                </div>
                <h2 className="font-display text-3xl text-bright tracking-wide">CLOUD TRANSCODER</h2>
              </div>
              <p className="text-subtle font-body text-sm mt-1">
                Offload CPU-intensive SVT-AV1 video encoding to free 4-vCPU Kaggle cloud instances (12 hours runtime, 30 GB RAM).
                Archive directly to <code className="text-accent font-mono text-xs">odrivecrypt</code> without taxing your local machine.
              </p>
            </div>

            {/* Guided 3-Step Setup */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
              <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-accent/20 border border-accent/40 text-accent flex items-center justify-center text-xs">
                  1
                </span>
                Kaggle Account Setup &amp; Prerequisite Checklist
              </h3>

              <div className="space-y-3 text-xs text-subtle font-body">
                <div className="p-3 rounded-lg bg-surface/50 border border-border/80 flex items-center justify-between">
                  <div>
                    <strong className="text-white block">Step 1: Free Kaggle Account</strong>
                    <span>Sign up at Kaggle if you haven't already.</span>
                  </div>
                  <a
                    href="https://www.kaggle.com"
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 shrink-0"
                  >
                    <span>kaggle.com</span>
                    <ExternalLink size={11} />
                  </a>
                </div>

                <div className="p-3 rounded-lg bg-surface/50 border border-border/80 flex items-center justify-between">
                  <div>
                    <strong className="text-white block">Step 2: One-Time Phone Verification (Required)</strong>
                    <span>Kaggle requires 1-time SMS verification to grant internet access to download/upload videos.</span>
                  </div>
                  <a
                    href="https://www.kaggle.com/settings"
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 shrink-0 text-accent border-accent/30"
                  >
                    <span>Verify Phone</span>
                    <ExternalLink size={11} />
                  </a>
                </div>

                <div className="p-3 rounded-lg bg-surface/50 border border-border/80 flex items-center justify-between">
                  <div>
                    <strong className="text-white block">Step 3: Generate API Token</strong>
                    <span>In Kaggle Settings, scroll to "API" and click "Create New Token" to download kaggle.json.</span>
                  </div>
                  <a
                    href="https://www.kaggle.com/settings"
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 shrink-0"
                  >
                    <span>API Settings</span>
                    <ExternalLink size={11} />
                  </a>
                </div>
              </div>

              {/* Credentials Form */}
              <div className="pt-3 border-t border-border space-y-4">
                <div>
                  <label className="text-xs font-heading font-medium text-white mb-1.5 block">
                    Kaggle Username
                  </label>
                  <input
                    type="text"
                    value={kaggleUserInput}
                    onChange={(e) => setKaggleUserInput(e.target.value)}
                    placeholder="e.g. clarkkent872"
                    className="input-field text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="text-xs font-heading font-medium text-white mb-1.5 block">
                    Kaggle API Key
                  </label>
                  <input
                    type="password"
                    value={kaggleKeyInput}
                    onChange={(e) => setKaggleKeyInput(e.target.value)}
                    placeholder="Paste 32-character key from kaggle.json"
                    className="input-field text-xs font-mono"
                  />
                  <p className="text-[11px] text-subtle font-body mt-1">
                    🔒 Kept strictly in the OS-level local secure store; never saved to localStorage.
                  </p>
                </div>

                {/* Test Result Message */}
                {kaggleTestResult && (
                  <div
                    className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs font-body ${
                      kaggleTestResult.ok
                        ? "bg-emerald-950/40 border-emerald-800/40 text-emerald-200"
                        : "bg-red-950/40 border-red-800/40 text-red-200"
                    }`}
                  >
                    {kaggleTestResult.ok ? (
                      <Check size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                    ) : (
                      <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
                    )}
                    <span>{kaggleTestResult.message}</span>
                  </div>
                )}

                <div className="flex items-center gap-3 pt-2">
                  <button
                    onClick={handleSaveKaggle}
                    className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                  >
                    {savedKaggle ? <Check size={14} className="text-emerald-300" /> : <Save size={14} />}
                    <span>{savedKaggle ? "Saved" : "Save Credentials"}</span>
                  </button>

                  <button
                    onClick={handleTestKaggle}
                    disabled={testingKaggle || !kaggleUserInput.trim() || !kaggleKeyInput.trim()}
                    className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {testingKaggle ? (
                      <Loader2 size={14} className="animate-spin text-accent" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    <span>{testingKaggle ? "Testing..." : "Test Connection"}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleImportKaggleJson}
                    title="Read credentials directly from ~/kaggle.json or ~/.kaggle/kaggle.json"
                    className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
                  >
                    <Folder size={14} />
                    <span>Import ~/kaggle.json</span>
                  </button>
                </div>

                {/* Backup Kaggle Account Pool */}
                <div className="space-y-2 pt-3 border-t border-border/40">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-subtle uppercase">Backup Kaggle Account Pool</span>
                    <button
                      type="button"
                      onClick={() => setShowAddKaggle(!showAddKaggle)}
                      className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 cursor-pointer"
                    >
                      <Plus size={12} />
                      <span>{showAddKaggle ? "Cancel" : "Add Backup Account"}</span>
                    </button>
                  </div>

                  {(kaggleAccounts || []).length > 0 ? (
                    (kaggleAccounts || []).map((a) => (
                      <div key={a.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface border border-border text-xs">
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold text-text">{a.label}</span>
                          <span className="text-subtle font-mono ml-2">({a.username})</span>
                        </div>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${a.isExhausted ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                          {a.isExhausted ? "Quota Exhausted" : "Standby"}
                        </span>
                        <button
                          type="button"
                          onClick={() => setKaggleAccounts((kaggleAccounts || []).filter((x) => x.id !== a.id))}
                          className="p-1 text-subtle hover:text-rose-400 cursor-pointer"
                          title="Remove backup account"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="text-[11px] text-subtle italic">No backup Kaggle accounts configured.</p>
                  )}

                  {showAddKaggle && (
                    <div className="p-3 rounded-lg bg-surface/80 border border-border space-y-3 mt-2">
                      <span className="text-xs font-semibold text-white block">Add Kaggle Backup Account</span>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <input
                          type="text"
                          value={newKaggleLabel}
                          onChange={(e) => setNewKaggleLabel(e.target.value)}
                          placeholder="Label (e.g. Org Account)"
                          className="input-field text-xs font-mono"
                        />
                        <input
                          type="text"
                          value={newKaggleUser}
                          onChange={(e) => setNewKaggleUser(e.target.value)}
                          placeholder="Kaggle Username"
                          className="input-field text-xs font-mono"
                        />
                        <input
                          type="password"
                          value={newKaggleKey}
                          onChange={(e) => setNewKaggleKey(e.target.value)}
                          placeholder="Kaggle API Key"
                          className="input-field text-xs font-mono"
                        />
                      </div>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (!newKaggleUser.trim() || !newKaggleKey.trim()) {
                              useToastStore.getState().addToast("Username and key are required", "error");
                              return;
                            }
                            const acct: KaggleAccount = {
                              id: `kaggle-${Date.now()}`,
                              label: newKaggleLabel.trim() || `Account (${newKaggleUser.trim()})`,
                              username: newKaggleUser.trim(),
                              key: newKaggleKey.trim(),
                              enabled: true,
                            };
                            setKaggleAccounts([...(kaggleAccounts || []), acct]);
                            setNewKaggleLabel("");
                            setNewKaggleUser("");
                            setNewKaggleKey("");
                            setShowAddKaggle(false);
                            useToastStore.getState().addToast("Added backup Kaggle account", "success");
                          }}
                          className="btn-accent text-xs py-1.5 px-3 flex items-center gap-1 cursor-pointer"
                        >
                          <Check size={12} />
                          <span>Save Account</span>
                        </button>
                      </div>
                    </div>
                  )}

                  <p className="text-[10px] text-subtle">
                    Add accounts you legitimately control. Auto-failover engages when the active account's GPU quota or session limit is reached.
                  </p>
                </div>
              </div>
            </div>

            {/* Multi-Provider Worker Rotation & GitHub Actions Fallback */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
                    <CloudUpload size={16} className="text-accent" />
                    <span>Multi-Provider Cloud Worker Rotation</span>
                  </h3>
                  <p className="text-subtle font-body text-xs mt-0.5">
                    Automatically rotate tasks (transfers, transcodes, Whispersync alignments) to a free GitHub Actions runner when Kaggle has &ge; 2 concurrent jobs or hits rate limits.
                  </p>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ghaEnabled}
                    onChange={(e) => setGhaEnabled(e.target.checked)}
                    className="rounded border-border text-accent focus:ring-accent bg-surface"
                  />
                  <span className="text-xs font-semibold text-white">Enable Rotation</span>
                </label>
              </div>

              {ghaEnabled && (
                <div className="pt-3 border-t border-border space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-heading font-medium text-white mb-1.5 block">
                        GitHub Repository Owner
                      </label>
                      <input
                        type="text"
                        value={ghaOwnerInput}
                        onChange={(e) => setGhaOwnerInput(e.target.value)}
                        placeholder="e.g. your-github-username"
                        className="input-field text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-heading font-medium text-white mb-1.5 block">
                        Repository Name
                      </label>
                      <input
                        type="text"
                        value={ghaRepoInput}
                        onChange={(e) => setGhaRepoInput(e.target.value)}
                        placeholder="e.g. rcloneflix-workers"
                        className="input-field text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-heading font-medium text-white mb-1.5 block">
                      GitHub Personal Access Token (PAT)
                    </label>
                    <input
                      type="password"
                      value={ghaTokenInput}
                      onChange={(e) => setGhaTokenInput(e.target.value)}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx (Requires 'repo' or 'actions:write' scope)"
                      className="input-field text-xs font-mono"
                    />
                    <p className="text-[11px] text-subtle font-body mt-1">
                      Runs ephemeral Ubuntu runners (2,000 min/mo free). Fast 15s startup for offloading queues.
                    </p>
                  </div>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={ghaAllowPublic}
                      onChange={(e) => setGhaAllowPublic(e.target.checked)}
                      className="rounded border-border text-accent focus:ring-accent bg-surface"
                    />
                    <span className="text-xs text-subtle">
                      Allow public worker repo (I understand secrets will be visible)
                    </span>
                  </label>

                  {ghaTestResult && (
                    <div
                      className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs font-body ${
                        ghaTestResult.ok
                          ? "bg-emerald-950/40 border-emerald-800/40 text-emerald-200"
                          : "bg-red-950/40 border-red-800/40 text-red-200"
                      }`}
                    >
                      {ghaTestResult.ok ? (
                        <Check size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
                      )}
                      <span>{ghaTestResult.message}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <button
                      onClick={handleSaveGha}
                      className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                    >
                      {savedGha ? <Check size={14} className="text-emerald-300" /> : <Save size={14} />}
                      <span>{savedGha ? "Saved" : "Save Runner Settings"}</span>
                    </button>

                    <button
                      onClick={handleTestGha}
                      disabled={testingGha || !ghaTokenInput.trim() || !ghaOwnerInput.trim() || !ghaRepoInput.trim()}
                      className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {testingGha ? (
                        <Loader2 size={14} className="animate-spin text-accent" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      <span>{testingGha ? "Testing..." : "Test GitHub Connection"}</span>
                    </button>

                    <button
                      onClick={() => handleProvisionGha(false)}
                      disabled={provisioningGha || !ghaTokenInput.trim()}
                      className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                    >
                      {provisioningGha ? (
                        <Loader2 size={14} className="animate-spin text-accent" />
                      ) : (
                        <CloudUpload size={14} />
                      )}
                      <span>Provision / Sync Worker</span>
                    </button>

                    <button
                      onClick={() => handleProvisionGha(true)}
                      disabled={provisioningGha || !ghaTokenInput.trim()}
                      className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Zap size={14} />
                      <span>Force Sync Workflow</span>
                    </button>
                  </div>

                  {/* Backup GitHub Actions Account Pool */}
                  <div className="space-y-2 pt-3 border-t border-border/40">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-subtle uppercase">Backup GitHub Actions Runner Pool</span>
                      <button
                        type="button"
                        onClick={() => setShowAddGha(!showAddGha)}
                        className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1 cursor-pointer"
                      >
                        <Plus size={12} />
                        <span>{showAddGha ? "Cancel" : "Add Backup Account"}</span>
                      </button>
                    </div>

                    {(ghaAccounts || []).length > 0 ? (
                      (ghaAccounts || []).map((a) => (
                        <div key={a.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface border border-border text-xs">
                          <div className="min-w-0 flex-1">
                            <span className="font-semibold text-text">{a.label}</span>
                            <span className="text-subtle font-mono ml-2">{a.owner}/{a.repo}</span>
                          </div>
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${a.isExhausted ? "bg-rose-500/15 text-rose-300" : "bg-emerald-500/15 text-emerald-300"}`}>
                            {a.isExhausted ? "Quota Exhausted" : "Standby"}
                          </span>
                          <button
                            type="button"
                            onClick={() => setGhaAccounts((ghaAccounts || []).filter((x) => x.id !== a.id))}
                            className="p-1 text-subtle hover:text-rose-400 cursor-pointer"
                            title="Remove backup runner"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))
                    ) : (
                      <p className="text-[11px] text-subtle italic">No backup runner accounts configured.</p>
                    )}

                    {showAddGha && (
                      <div className="p-3 rounded-lg bg-surface/80 border border-border space-y-3 mt-2">
                        <span className="text-xs font-semibold text-white block">Add GitHub Actions Backup Account</span>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <input
                            type="text"
                            value={newGhaLabel}
                            onChange={(e) => setNewGhaLabel(e.target.value)}
                            placeholder="Label (e.g. Org Runner)"
                            className="input-field text-xs font-mono"
                          />
                          <input
                            type="text"
                            value={newGhaOwner}
                            onChange={(e) => setNewGhaOwner(e.target.value)}
                            placeholder="GitHub Owner / Org"
                            className="input-field text-xs font-mono"
                          />
                          <input
                            type="text"
                            value={newGhaRepo}
                            onChange={(e) => setNewGhaRepo(e.target.value)}
                            placeholder="Repository Name"
                            className="input-field text-xs font-mono"
                          />
                          <input
                            type="password"
                            value={newGhaToken}
                            onChange={(e) => setNewGhaToken(e.target.value)}
                            placeholder="Personal Access Token (PAT)"
                            className="input-field text-xs font-mono"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              if (!newGhaOwner.trim() || !newGhaRepo.trim() || !newGhaToken.trim()) {
                                useToastStore.getState().addToast("Owner, repo, and token are required", "error");
                                return;
                              }
                              const acct: GhaAccount = {
                                id: `gha-${Date.now()}`,
                                label: newGhaLabel.trim() || `Account (${newGhaOwner.trim()})`,
                                owner: newGhaOwner.trim(),
                                repo: newGhaRepo.trim(),
                                token: newGhaToken.trim(),
                                enabled: true,
                              };
                              setGhaAccounts([...(ghaAccounts || []), acct]);
                              setNewGhaLabel("");
                              setNewGhaOwner("");
                              setNewGhaRepo("");
                              setNewGhaToken("");
                              setShowAddGha(false);
                              useToastStore.getState().addToast("Added backup GitHub Actions runner", "success");
                            }}
                            className="btn-accent text-xs py-1.5 px-3 flex items-center gap-1 cursor-pointer"
                          >
                            <Check size={12} />
                            <span>Save Runner</span>
                          </button>
                        </div>
                      </div>
                    )}

                    <p className="text-[10px] text-subtle">
                      Add accounts you legitimately control (e.g. an organization account or paid plan). Auto-failover engages when the active runner's included minutes run out.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Cloud Transcode Activity List */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-heading font-semibold text-white text-sm">
                    Recent Cloud Transcode Jobs
                  </h3>
                  <p className="text-subtle font-body text-xs mt-0.5">
                    Jobs execute in Google/Kaggle's cloud even if RcloneFlix is closed.
                  </p>
                </div>
              </div>

              <CloudJobsActivityList />
            </div>
          </div>
        )}

        {/* Cast, DLNA & Remote Streaming */}
        {section === "dlna" && (
          <div className="max-w-2xl space-y-6">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
                  <Cast size={18} />
                </div>
                <h2 className="font-display text-3xl text-bright tracking-wide">CAST, DLNA &amp; REMOTE</h2>
              </div>
              <p className="text-subtle font-body text-sm mt-1">
                Stream media seamlessly across your devices. Cast directly to Chromecast, Google TV &amp; smart speakers, broadcast DLNA to Xbox &amp; Smart TVs, or expose WebDAV via Tailscale Serve &amp; Funnel.
              </p>
            </div>

            {/* Google Cast Section */}
            <GoogleCastSettingsSection />

            {/* Server Controls Card */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-3 h-3 rounded-full ${dlnaStatus?.running ? "bg-emerald-400 animate-pulse ring-4 ring-emerald-500/20" : "bg-white/20"}`} />
                  <div>
                    <h3 className="font-heading font-semibold text-white text-sm">
                      {dlnaStatus?.running ? "DLNA Server Active" : "DLNA Server Inactive"}
                    </h3>
                    <p className="text-xs text-subtle font-body mt-0.5">
                      {dlnaStatus?.running
                        ? `Broadcasting on 0.0.0.0:${dlnaStatus.port} (${dlnaStatus.friendly_name})`
                        : "Turn on to share media with Xbox, Kodi, and Smart TVs on your Wi-Fi."}
                    </p>
                  </div>
                </div>

                <button
                  onClick={handleToggleDlna}
                  disabled={isOperatingDlna}
                  className={`text-xs py-2 px-4 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${
                    dlnaStatus?.running
                      ? "btn-danger"
                      : "btn-accent"
                  }`}
                >
                  {isOperatingDlna && <Loader2 size={13} className="animate-spin" />}
                  <span>{dlnaStatus?.running ? "Stop Server" : "Start DLNA Server"}</span>
                </button>
              </div>

              {dlnaStatus?.error && (
                <div className="p-3 rounded-lg bg-red-950/40 border border-red-800/40 text-red-300 text-xs flex items-center gap-2">
                  <AlertCircle size={14} className="shrink-0" />
                  <span>{dlnaStatus.error}</span>
                </div>
              )}

              {/* Configuration Inputs */}
              <div className="grid grid-cols-2 gap-4 border-t border-border/80 pt-4">
                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">Source Remote</label>
                  <select
                    value={dlnaRemote}
                    onChange={(e) => setDlnaRemote(e.target.value)}
                    disabled={dlnaStatus?.running}
                    className="input-field w-full text-xs font-mono"
                  >
                    {remotes.map((r) => (
                      <option key={r.name} value={r.name}>
                        {r.name} ({r.type})
                      </option>
                    ))}
                    {remotes.length === 0 && <option value="telegram-drive">telegram-drive</option>}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">Subfolder (Optional)</label>
                  <input
                    type="text"
                    value={dlnaPath}
                    onChange={(e) => setDlnaPath(e.target.value)}
                    disabled={dlnaStatus?.running}
                    placeholder="e.g. Movies TD or leave empty for root"
                    className="input-field w-full text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">Friendly Server Name</label>
                  <input
                    type="text"
                    value={dlnaFriendlyName}
                    onChange={(e) => setDlnaFriendlyName(e.target.value)}
                    disabled={dlnaStatus?.running}
                    placeholder="RcloneFlix (Xbox & TV)"
                    className="input-field w-full text-xs"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">LAN Port</label>
                  <input
                    type="number"
                    value={dlnaPort}
                    onChange={(e) => setDlnaPort(parseInt(e.target.value) || 8200)}
                    disabled={dlnaStatus?.running}
                    className="input-field w-full text-xs font-mono"
                  />
                </div>
              </div>
            </div>

            {/* Device Quick Connect Instructions */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
              <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
                <Tv size={15} className="text-accent" />
                How to Play Media on Your Devices
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-subtle font-body">
                <div className="p-3.5 rounded-lg bg-surface/50 border border-border/70 space-y-1.5">
                  <div className="flex items-center gap-2 text-white font-medium">
                    <span className="text-accent font-mono text-sm">🎮</span>
                    <span>Xbox (One, Series X/S)</span>
                  </div>
                  <p className="leading-relaxed">
                    Open <strong className="text-white">Xbox Media Player</strong> or <strong className="text-white">Kodi</strong> on your console. Navigate to <em>Media Servers</em>. Choose <em>"{dlnaFriendlyName}"</em> to stream immediately!
                  </p>
                </div>

                <div className="p-3.5 rounded-lg bg-surface/50 border border-border/70 space-y-1.5">
                  <div className="flex items-center gap-2 text-white font-medium">
                    <span className="text-accent font-mono text-sm">📺</span>
                    <span>Smart TVs &amp; Media Boxes</span>
                  </div>
                  <p className="leading-relaxed">
                    Open <strong className="text-white">VLC</strong>, <strong className="text-white">Infuse</strong>, or your TV's built-in media browser. Select <em>Local Network</em> &rarr; <em>RcloneFlix</em>. Zero transcoding, direct 4K playback.
                  </p>
                </div>
              </div>
            </div>

            {/* Tailscale Remote WebDAV Assistant */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Wifi size={16} className="text-accent" />
                  <h3 className="font-heading font-semibold text-white text-sm">
                    Tailscale Remote Access (Serve &amp; Funnel)
                  </h3>
                </div>
                <button
                  onClick={fetchTailscaleStatus}
                  disabled={loadingTailscale}
                  className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1"
                >
                  <RefreshCw size={11} className={loadingTailscale ? "animate-spin" : ""} />
                  <span>Refresh</span>
                </button>
              </div>

              <p className="text-xs text-subtle font-body">
                Expose your local Telegram-Drive WebDAV (port 8551) securely across your private Tailscale tailnet (Serve) or to the global internet (Funnel) with automatic valid HTTPS TLS certificates.
              </p>

              {tailscaleStatus?.installed ? (
                <div className="p-3.5 rounded-lg bg-surface/60 border border-border/80 space-y-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-subtle">Tailscale Status:</span>
                    <span className={`font-mono text-xs font-semibold px-2 py-0.5 rounded ${
                      tailscaleStatus.running ? "bg-emerald-950/50 text-emerald-400 border border-emerald-800/40" : "bg-amber-950/50 text-amber-400 border border-amber-800/40"
                    }`}>
                      {tailscaleStatus.backend_state}
                    </span>
                  </div>

                  {tailscaleStatus.dns_name && (
                    <div className="flex items-center justify-between">
                      <span className="text-subtle">Tailscale Node DNS:</span>
                      <span className="font-mono text-white text-xs">{tailscaleStatus.dns_name}</span>
                    </div>
                  )}

                  {/* Active Routes Info */}
                  {tailscaleRoutes.length > 0 && (
                    <div className="pt-2 border-t border-border/60 space-y-1.5">
                      <span className="text-subtle font-medium">Active Proxy Routes:</span>
                      {tailscaleRoutes.map((r, idx) => (
                        <div key={idx} className="flex items-center justify-between p-2 rounded bg-black/30 border border-border/50 text-[11px] font-mono">
                          <span className="text-emerald-400">{r.url}</span>
                          <span className="text-subtle">&rarr; {r.target} {r.is_funnel ? "(Public Funnel)" : "(Private Serve)"}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {tailscaleStatus.running && tailscaleStatus.dns_name ? (
                    <div className="pt-2 border-t border-border/60 space-y-3">
                      <div>
                        <p className="text-subtle mb-1.5">Capability Access Link (Tokenized Passwordless WebDAV):</p>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            readOnly
                            value={`https://${tailscaleStatus.dns_name}:8443/dav/fd881c0f554f776020c2b1edeae05899af73142dc3d768ab029638b9f01ca33d/`}
                            className="input-field text-xs font-mono flex-1 text-emerald-400"
                          />
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(`https://${tailscaleStatus.dns_name}:8443/dav/fd881c0f554f776020c2b1edeae05899af73142dc3d768ab029638b9f01ca33d/`);
                              useToastStore.getState().addToast("WebDAV Capability URL copied!", "success");
                            }}
                            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1 shrink-0"
                          >
                            <Copy size={12} /> Copy
                          </button>
                        </div>
                      </div>

                      {/* 1-Click Action Controls */}
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                        <button
                          onClick={handleEnableServe}
                          disabled={operatingTailscale}
                          className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-1.5 text-accent font-semibold"
                          title="Expose WebDAV securely to your private Tailscale network devices only"
                        >
                          {operatingTailscale ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                          <span>Enable Serve (Tailnet)</span>
                        </button>

                        <button
                          onClick={handleEnableFunnel}
                          disabled={operatingTailscale}
                          className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-1.5 text-emerald-400 font-semibold"
                          title="Expose WebDAV publicly to any web application on the internet"
                        >
                          {operatingTailscale ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
                          <span>Enable Funnel (Public)</span>
                        </button>

                        <button
                          onClick={handleResetTailscale}
                          disabled={operatingTailscale}
                          className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-1.5 text-subtle hover:text-white"
                          title="Clear and stop all active Tailscale Serve and Funnel proxies"
                        >
                          <X size={12} />
                          <span>Reset Routes</span>
                        </button>
                      </div>

                      <div className="p-3 rounded-lg bg-black/40 border border-border/50 text-[11px] text-subtle space-y-1">
                        <p className="font-semibold text-white/90">How Passwordless Capability URLs Work:</p>
                        <p className="leading-relaxed">
                          Telegram-Drive embeds a cryptographic 64-character capability token into its WebDAV path. When published over Tailscale Serve or Funnel, anyone with this full URL has authorized access to read and stream files—no HTTP Basic Auth password prompt is required. Keep your capability URL private if public Funnel is active.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="pt-2 border-t border-border/60">
                      <p className="text-amber-300/90 text-xs">
                        Tailscale is installed but not running or logged out. Run <code className="font-mono bg-black/40 px-1 py-0.5 rounded text-white">tailscale up</code> to generate your remote URLs.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-3.5 rounded-lg bg-surface/40 border border-border/60 text-xs text-subtle">
                  Tailscale CLI is not detected on this system. Install Tailscale to enable zero-configuration HTTPS tunnels for WebDAV.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Easynews & Debrid Resolvers */}
        {section === "debrid" && (
          <div className="max-w-2xl space-y-6">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
                  <Globe size={18} />
                </div>
                <h2 className="font-display text-3xl text-bright tracking-wide">EASYNEWS &amp; DEBRID RESOLVERS</h2>
              </div>
              <p className="text-subtle font-body text-sm mt-1">
                Configure Usenet multi-search credentials and cyberlocker debrid unrestrict resolvers (Real-Debrid, Premiumize, Offcloud) to seamlessly play and save web streams.
              </p>
            </div>

            {/* Easynews Card */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
                    <Cloud size={16} className="text-accent" />
                    <span>Easynews Global Multi-Search</span>
                  </h3>
                  <p className="text-xs text-subtle font-body mt-0.5">
                    Search millions of Usenet video, audio, book, and archive releases directly from RcloneFlix.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setEasynewsEnabled(!easynewsEnabled)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    easynewsEnabled ? "bg-accent" : "bg-white/10"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      easynewsEnabled ? "translate-x-5 bg-void" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-border/80 pt-4 font-body">
                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">Easynews Username</label>
                  <input
                    type="text"
                    value={easynewsUsername}
                    onChange={(e) => setEasynewsUsername(e.target.value)}
                    placeholder="e.g. your_easynews_login"
                    className="input-field w-full text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">Easynews Password</label>
                  <input
                    type="password"
                    value={easynewsPassword}
                    onChange={(e) => setEasynewsPassword(e.target.value)}
                    placeholder="Account password"
                    className="input-field w-full text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">SSL Port</label>
                  <select
                    value={easynewsPort}
                    onChange={(e) => setEasynewsPort(Number(e.target.value))}
                    className="input-field w-full text-xs font-mono"
                  >
                    <option value={443}>443 (Standard HTTPS)</option>
                    <option value={444}>444 (Alternative SSL)</option>
                  </select>
                </div>

                <div className="flex flex-col justify-end">
                  <div className="p-2.5 rounded-lg bg-surface/50 border border-border/60 text-[11px] text-subtle">
                    Searches: <span className="text-white font-medium">Video, Audio, Books/PDFs, Archives</span>. DirectPlay actions enabled on all results.
                  </div>
                </div>
              </div>

              {easynewsTestResult && (
                <div
                  className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs font-body ${
                    easynewsTestResult.ok
                      ? "bg-emerald-950/40 border-emerald-800/40 text-emerald-200"
                      : "bg-red-950/40 border-red-800/40 text-red-200"
                  }`}
                >
                  {easynewsTestResult.ok ? (
                    <Check size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
                  )}
                  <span>{easynewsTestResult.message}</span>
                </div>
              )}

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleSaveEasynews}
                  className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
                >
                  {savedEasynews ? <Check size={14} /> : <Save size={14} />}
                  <span>{savedEasynews ? "Saved" : "Save Easynews"}</span>
                </button>

                <button
                  type="button"
                  onClick={handleTestEasynews}
                  disabled={testingEasynews || !easynewsUsername.trim() || !easynewsPassword.trim()}
                  className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                >
                  {testingEasynews ? (
                    <Loader2 size={14} className="animate-spin text-accent" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  <span>{testingEasynews ? "Verifying…" : "Test Connection"}</span>
                </button>
              </div>
            </div>

            {/* Debrid Resolvers Card */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
              <div>
                <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
                  <Zap size={16} className="text-accent" />
                  <span>Debrid Unrestrict Resolvers (DirectPlay Link Resolver)</span>
                </h3>
                <p className="text-xs text-subtle font-body mt-0.5">
                  Paste Rapidgator, Gofile, Pixeldrain, 1fichier, Turbobit, Scribd, or torrent magnet links into DirectPlay. RcloneFlix will automatically resolve and stream them high-speed via your debrid account.
                </p>
              </div>

              <div className="space-y-4 border-t border-border/80 pt-4 font-body text-xs">
                {/* Real-Debrid */}
                <div className="p-3.5 rounded-lg bg-surface/50 border border-border/70 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white flex items-center gap-1.5">
                      <span className="text-accent font-mono">⚡</span> Real-Debrid API Token
                    </span>
                    <a
                      href="https://real-debrid.com/apitoken"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-accent hover:underline flex items-center gap-1"
                    >
                      <span>Get API Token</span>
                      <ExternalLink size={10} />
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={realDebridKey}
                      onChange={(e) => setRealDebridKey(e.target.value)}
                      placeholder="Paste your Real-Debrid API token"
                      className="input-field flex-1 text-xs font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => handleTestDebrid("realdebrid")}
                      disabled={testingDebrid === "realdebrid" || !realDebridKey.trim()}
                      className="btn-secondary text-xs py-2 px-3 flex items-center gap-1 shrink-0 disabled:opacity-50"
                    >
                      {testingDebrid === "realdebrid" ? <Loader2 size={12} className="animate-spin text-accent" /> : <RefreshCw size={12} />}
                      <span>Test</span>
                    </button>
                  </div>
                </div>

                {/* Premiumize.me */}
                <div className="p-3.5 rounded-lg bg-surface/50 border border-border/70 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white flex items-center gap-1.5">
                      <span className="text-accent font-mono">⭐</span> Premiumize.me API Key
                    </span>
                    <a
                      href="https://www.premiumize.me/account"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-accent hover:underline flex items-center gap-1"
                    >
                      <span>Account Settings</span>
                      <ExternalLink size={10} />
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={premiumizeKey}
                      onChange={(e) => setPremiumizeKey(e.target.value)}
                      placeholder="Paste your Premiumize.me API key"
                      className="input-field flex-1 text-xs font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => handleTestDebrid("premiumize")}
                      disabled={testingDebrid === "premiumize" || !premiumizeKey.trim()}
                      className="btn-secondary text-xs py-2 px-3 flex items-center gap-1 shrink-0 disabled:opacity-50"
                    >
                      {testingDebrid === "premiumize" ? <Loader2 size={12} className="animate-spin text-accent" /> : <RefreshCw size={12} />}
                      <span>Test</span>
                    </button>
                  </div>
                </div>

                {/* Offcloud */}
                <div className="p-3.5 rounded-lg bg-surface/50 border border-border/70 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-white flex items-center gap-1.5">
                      <span className="text-accent font-mono">🌐</span> Offcloud API Key
                    </span>
                    <a
                      href="https://offcloud.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-accent hover:underline flex items-center gap-1"
                    >
                      <span>offcloud.com</span>
                      <ExternalLink size={10} />
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={offcloudKey}
                      onChange={(e) => setOffcloudKey(e.target.value)}
                      placeholder="Paste your Offcloud API key"
                      className="input-field flex-1 text-xs font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => handleTestDebrid("offcloud")}
                      disabled={testingDebrid === "offcloud" || !offcloudKey.trim()}
                      className="btn-secondary text-xs py-2 px-3 flex items-center gap-1 shrink-0 disabled:opacity-50"
                    >
                      {testingDebrid === "offcloud" ? <Loader2 size={12} className="animate-spin text-accent" /> : <RefreshCw size={12} />}
                      <span>Test</span>
                    </button>
                  </div>
                </div>
              </div>

              {debridTestResult && (
                <div
                  className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs font-body ${
                    debridTestResult.ok
                      ? "bg-emerald-950/40 border-emerald-800/40 text-emerald-200"
                      : "bg-red-950/40 border-red-800/40 text-red-200"
                  }`}
                >
                  {debridTestResult.ok ? (
                    <Check size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
                  )}
                  <span>{debridTestResult.message}</span>
                </div>
              )}

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleSaveDebrid}
                  className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
                >
                  {savedDebrid ? <Check size={14} /> : <Save size={14} />}
                  <span>{savedDebrid ? "Saved" : "Save Debrid Resolvers"}</span>
                </button>
              </div>
            </div>

            {/* Stremio Community Addons Card */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
                    <Zap size={16} className="text-accent" />
                    <span>Stremio Community &amp; Multi-Tracker Addons</span>
                  </h3>
                  <p className="text-xs text-subtle font-body mt-0.5">
                    Connect any Stremio Addon manifest URL (such as Torrentio, Comet, KnightCrawler, or MediaFusion) to aggregate multi-tracker torrents and embedded Debrid caches.
                  </p>
                </div>
              </div>

              {/* Add New Addon Input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newStremioUrl}
                  onChange={(e) => setNewStremioUrl(e.target.value)}
                  placeholder="Paste addon manifest URL (e.g. https://torrentio.strem.fun/.../manifest.json)"
                  className="input-field flex-1 text-xs font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddStremioAddon();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={handleAddStremioAddon}
                  disabled={addingStremio || !newStremioUrl.trim()}
                  className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                >
                  {addingStremio ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                  <span>Add Addon</span>
                </button>
              </div>

              {/* Installed Addons List */}
              <div className="space-y-2 pt-2 border-t border-border/80">
                <span className="text-[11px] font-mono uppercase text-subtle tracking-wider">
                  Configured Addons ({(stremioAddons || []).length})
                </span>

                {(!stremioAddons || stremioAddons.length === 0) ? (
                  <p className="text-xs text-subtle italic py-2">
                    No Stremio addons added yet. Paste a manifest.json URL above to get started.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {stremioAddons.map((addon) => (
                      <div
                        key={addon.id}
                        className="p-3 rounded-lg bg-surface/50 border border-border/70 flex items-center justify-between gap-3"
                      >
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-white text-xs">
                              {addon.name}
                            </span>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-panel border border-border text-subtle">
                              v{addon.version}
                            </span>
                            {addon.hasDebridEmbedded && (
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-semibold">
                                Debrid Embedded
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] font-mono text-subtle truncate max-w-md">
                            {addon.manifestUrl}
                          </p>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => toggleStremioAddon(addon.id, !addon.enabled)}
                            className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                              addon.enabled
                                ? "bg-accent/15 border border-accent/40 text-accent"
                                : "bg-panel border border-border text-subtle"
                            }`}
                          >
                            {addon.enabled ? "Active" : "Disabled"}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              removeStremioAddon(addon.id);
                              useToastStore.getState().addToast(`Removed ${addon.name}`, "info");
                            }}
                            className="p-1.5 text-subtle hover:text-danger rounded-lg hover:bg-white/5 transition-colors"
                            title="Remove Addon"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <UsenetIndexerSettingsCard />
          </div>
        )}

        {section === "streamtape" && (
          <StreamtapeSettingsSection />
        )}

        {section === "telegram" && (
          <TelegramSettingsSection />
        )}

        {section === "udrop" && (
          <UdropSettingsSection />
        )}

        {section === "storyteller" && (
          <div className="max-w-2xl space-y-6">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-amber-400">
                  <Sparkles size={18} />
                </div>
                <h2 className="font-display text-3xl text-bright tracking-wide">STORYTELLER &amp; WHISPER ALIGNMENT</h2>
              </div>
              <p className="text-subtle font-body text-sm mt-1">
                Configure your self-hosted Storyteller server or run 1-click cloud Whisper alignment jobs on Kaggle T4 GPUs to generate exact EPUB 3 Media Overlays (SMIL) for Immersion Reading.
              </p>
            </div>

            {/* Storyteller Server Config Card */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
                    <BookOpen size={16} className="text-accent" />
                    <span>Storyteller Server &amp; OPDS Sync</span>
                  </h3>
                  <p className="text-xs text-subtle font-body mt-0.5">
                    Connect to your self-hosted Storyteller instance to sync pre-aligned books with embedded SMIL narration.
                  </p>
                </div>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-accent/15 border border-accent/30 text-accent font-semibold">
                  OPDS 1.2 / 2.0
                </span>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">Server URL</label>
                  <input
                    type="text"
                    value={storytellerUrl}
                    onChange={(e) => setStorytellerUrl(e.target.value)}
                    placeholder="e.g. http://192.168.1.10:8001 or https://storyteller.myhome.org"
                    className="input-field w-full text-xs font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-white mb-1.5">API Key / Bearer Token (Optional)</label>
                  <input
                    type="password"
                    value={storytellerApiKey}
                    onChange={(e) => setStorytellerApiKey(e.target.value)}
                    placeholder="Leave empty if your server has no authentication"
                    className="input-field w-full text-xs font-mono"
                  />
                </div>
              </div>

              {storytellerTestResult && (
                <div
                  className={`p-3 rounded-xl border flex items-start gap-2.5 text-xs font-body ${
                    storytellerTestResult.ok
                      ? "bg-emerald-950/40 border-emerald-800/40 text-emerald-200"
                      : "bg-red-950/40 border-red-800/40 text-red-200"
                  }`}
                >
                  {storytellerTestResult.ok ? (
                    <Check size={15} className="text-emerald-400 shrink-0 mt-0.5" />
                  ) : (
                    <AlertCircle size={15} className="text-red-400 shrink-0 mt-0.5" />
                  )}
                  <span>{storytellerTestResult.message}</span>
                </div>
              )}

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={handleSaveStoryteller}
                  className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
                >
                  {savedStoryteller ? <Check size={14} /> : <Save size={14} />}
                  <span>{savedStoryteller ? "Saved" : "Save Storyteller Config"}</span>
                </button>
                <button
                  type="button"
                  onClick={handleTestStoryteller}
                  disabled={testingStoryteller || !storytellerUrl.trim()}
                  className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                >
                  {testingStoryteller ? (
                    <Loader2 size={13} className="animate-spin text-accent" />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  <span>{testingStoryteller ? "Testing…" : "Test Connection"}</span>
                </button>
                <button
                  type="button"
                  onClick={handleFetchStorytellerBooks}
                  disabled={fetchingStorytellerBooks || !storytellerUrl.trim()}
                  className="btn-secondary text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
                >
                  {fetchingStorytellerBooks ? (
                    <Loader2 size={13} className="animate-spin text-accent" />
                  ) : (
                    <BookOpen size={13} />
                  )}
                  <span>Fetch Synced Books</span>
                </button>
              </div>

              {storytellerBooks.length > 0 && (
                <div className="pt-3 border-t border-border space-y-2">
                  <p className="text-xs font-semibold text-white">
                    Synced Books Available on Storyteller ({storytellerBooks.length})
                  </p>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {storytellerBooks.map((b) => (
                      <div
                        key={String(b.id)}
                        className="p-2.5 rounded-lg bg-surface/40 border border-border flex items-center justify-between text-xs"
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-white truncate">{b.title}</p>
                          {b.author && <p className="text-[11px] text-subtle">{b.author}</p>}
                        </div>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold shrink-0">
                          Whisper Synced
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Cloud Whisper Aligner Info Card */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <Cpu size={16} className="text-amber-400" />
                <h3 className="font-heading font-semibold text-white text-sm">
                  Kaggle Cloud Whisper Aligner
                </h3>
              </div>
              <p className="text-xs text-subtle leading-relaxed font-body">
                For books not hosted on a Storyteller server, RcloneFlix can dispatch a 1-click Faster-Whisper alignment script to Kaggle using your free 30-hour/week Nvidia T4 GPU quota. A 15-hour audiobook aligns in ~12 minutes and produces an EPUB 3 with exact SMIL Media Overlays.
              </p>
              <div className="p-3 rounded-lg bg-white/5 border border-white/10 text-xs text-subtle">
                <p>
                  Trigger cloud alignment directly from any book's detail page or reader by clicking <strong className="text-white">"Align Audio"</strong> or <strong className="text-white">"Pair Audiobook"</strong>.
                </p>
              </div>
            </div>
          </div>
        )}

        {section === "theme" && (
          <div className="max-w-2xl space-y-6">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
                  <Palette size={18} />
                </div>
                <h2 className="font-display text-3xl text-bright tracking-wide">APPEARANCE &amp; THEMES</h2>
              </div>
              <p className="text-subtle font-body text-sm mt-1">
                Customize your cinema interface accent colors, contrast levels, and display modes.
              </p>
            </div>

            {/* Accent Color Swatches */}
            <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
              <div>
                <h3 className="font-heading font-semibold text-white text-sm">Accent Color Preset</h3>
                <p className="text-xs text-subtle font-body mt-0.5">
                  Select a theme accent color for highlights, glowing badges, playback progress, and buttons.
                </p>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { id: "gold", name: "Cinema Gold", hex: "#E8A020", desc: "Classic warm amber projector glow (Default)" },
                  { id: "emerald", name: "Cyberpunk Emerald", hex: "#10B981", desc: "Vivid neon green matrix accent" },
                  { id: "cyan", name: "Ocean Cyan", hex: "#06B6D4", desc: "Deep sky blue sci-fi glow" },
                  { id: "crimson", name: "Theater Crimson", hex: "#E50914", desc: "Bold cinematic streaming red" },
                  { id: "amethyst", name: "Amethyst Purple", hex: "#8B5CF6", desc: "Vibrant royal violet aura" },
                  { id: "rose", name: "Sunset Rose", hex: "#F43F5E", desc: "Neon synthwave pink & rose" },
                ].map((th) => {
                  const isSelected = (themeConfig?.accent || "gold") === th.id;
                  return (
                    <button
                      key={th.id}
                      type="button"
                      onClick={() => setThemeConfig({ accent: th.id as any })}
                      className={`flex flex-col text-left p-3.5 rounded-xl border transition-all ${
                        isSelected
                          ? "bg-surface border-accent shadow-lg shadow-accent/10"
                          : "bg-surface/40 border-border/70 hover:border-border hover:bg-surface/80"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div
                          className="w-5 h-5 rounded-full border border-white/20 shadow-sm"
                          style={{ backgroundColor: th.hex }}
                        />
                        {isSelected && <Check size={14} className="text-accent" />}
                      </div>
                      <span className="text-sm font-semibold text-white">{th.name}</span>
                      <span className="text-[11px] text-subtle mt-1 leading-tight">{th.desc}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* OLED Mode */}
            <div className="bg-panel border border-border rounded-xl p-5 flex items-center justify-between">
              <div>
                <h3 className="font-heading font-semibold text-white text-sm">OLED Pure Black Mode</h3>
                <p className="text-xs text-subtle font-body mt-0.5 max-w-md">
                  Replaces the deep navy background with true pitch black (#000000). Perfect for OLED TVs, phone displays, and high-contrast night viewing.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setThemeConfig({ oledMode: !themeConfig?.oledMode })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  themeConfig?.oledMode ? "bg-accent" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    themeConfig?.oledMode ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Backup folder / file picker */}
      {showBackupBrowser && activeRemoteObj && (
        <RemoteBrowser
          remoteName={
            backupFolder.includes(":")
              ? backupFolder.slice(0, backupFolder.indexOf(":"))
              : activeRemoteObj.name
          }
          remoteType={activeRemoteObj.type}
          rcloneConfigPath={rcloneConfigPath}
          initialPath={backupFolder}
          fileMode={showBackupBrowser === "file"}
          fileFilter={/\.json(\.gz)?$/i}
          availableRemotes={remotes}
          onRemoteChange={(newRemote) => {
            const found = remotes.find((r) => r.name === newRemote);
            if (found) setBackupFolder(`${found.name}:`);
          }}
          selectLabel="Use this folder"
          onSelect={(picked) => {
            const mode = showBackupBrowser;
            setShowBackupBrowser(null);
            if (mode === "file" && /\.json(\.gz)?$/i.test(picked)) {
              void handleRemoteRestore(picked);
            } else {
              setBackupFolder(picked);
            }
          }}
          onClose={() => setShowBackupBrowser(null)}
        />
      )}

      {/* Folder Picker Modal */}
      {showBrowserFor && activeRemoteObj && (
        <RemoteBrowser
          remoteName={activeRemoteObj.name}
          remoteType={activeRemoteObj.type}
          rcloneConfigPath={rcloneConfigPath}
          initialPath={browserTargetPath}
          availableRemotes={remotes}
          onRemoteChange={(newRemote) => {
            const found = remotes.find((r) => r.name === newRemote);
            if (found && showBrowserFor) {
              if (showBrowserFor.mode === "new" && newLib) {
                const updated = [...newLib.remotePaths];
                updated[showBrowserFor.pathIndex] = `${found.name}:`;
                setNewLib({ ...newLib, remotePaths: updated });
              } else if (showBrowserFor.mode === "edit" && editingLib) {
                const updated = [...editingLib.remotePaths];
                updated[showBrowserFor.pathIndex] = `${found.name}:`;
                setEditingLib({ ...editingLib, remotePaths: updated });
              }
            }
          }}
          onSelect={(selectedPath: string) => {
            if (showBrowserFor.mode === "new" && newLib) {
              const updated = [...newLib.remotePaths];
              updated[showBrowserFor.pathIndex] = selectedPath;
              setNewLib({ ...newLib, remotePaths: updated });
            } else if (showBrowserFor.mode === "edit" && editingLib) {
              const updated = [...editingLib.remotePaths];
              updated[showBrowserFor.pathIndex] = selectedPath;
              setEditingLib({ ...editingLib, remotePaths: updated });
            }
            setShowBrowserFor(null);
          }}
          onClose={() => setShowBrowserFor(null)}
        />
      )}

      <CreateAccessPassModal
        isOpen={showCreatePassModal}
        onClose={() => setShowCreatePassModal(false)}
      />

      <ImportAccessPassModal
        isOpen={showImportPassModal}
        onClose={() => setShowImportPassModal(false)}
      />

      {showPasteConfigModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-panel border border-accent/40 rounded-2xl w-full max-w-2xl p-6 shadow-2xl relative font-body space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-heading font-semibold text-lg text-white">Edit / Paste rclone.conf</h3>
              <button
                onClick={() => setShowPasteConfigModal(false)}
                className="p-1.5 rounded-lg text-subtle hover:text-white hover:bg-surface/50"
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-subtle">
              Paste your complete <code className="text-accent">rclone.conf</code> contents below. Saving will immediately update the active configuration on this device.
            </p>
            <textarea
              value={pasteConfigText}
              onChange={(e) => setPasteConfigText(e.target.value)}
              rows={12}
              placeholder={"[myremote]\ntype = drive\n..."}
              className="input-field w-full font-mono text-xs p-3 leading-relaxed"
            />
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowPasteConfigModal(false)}
                className="btn-secondary text-xs py-2 px-4"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSavePastedConfig}
                className="btn-accent text-xs py-2 px-5 font-semibold"
              >
                Save Config
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Telegram Drive WebDAV Modal */}
      {showTelegramModal && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-panel border border-accent/40 rounded-2xl w-full max-w-md p-6 shadow-2xl relative font-body">
            <button
              onClick={() => setShowTelegramModal(false)}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-subtle hover:text-white hover:bg-surface/50 transition-colors"
            >
              <X size={18} />
            </button>
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 rounded-xl bg-accent/15 text-accent border border-accent/30">
                <HardDrive size={20} />
              </div>
              <div>
                <h3 className="font-heading font-semibold text-lg text-white">Add Telegram Drive (WebDAV)</h3>
                <p className="text-xs text-subtle">Connect local Telegram Drive via WebDAV loopback</p>
              </div>
            </div>

            <div className="p-3 rounded-lg bg-surface/40 border border-border/70 mb-4 text-xs text-subtle space-y-1">
              <p className="font-medium text-white/90">Requires Telegram-Drive Desktop</p>
              <p>
                Launch <span className="text-accent font-semibold">Telegram-Drive</span> and enable desktop WebDAV access. RcloneFlix mounts your Telegram files directly as a remote.
              </p>
            </div>

            {telegramError && (
              <div className="p-3 mb-4 rounded-lg bg-red-950/40 border border-red-800/40 text-red-300 text-xs flex items-center gap-2">
                <AlertCircle size={14} className="shrink-0" />
                <span>{telegramError}</span>
              </div>
            )}

            <form onSubmit={handleConnectTelegram} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-white mb-1">Remote Name in Rclone</label>
                <input
                  type="text"
                  value={telegramRemoteName}
                  onChange={(e) => setTelegramRemoteName(e.target.value)}
                  placeholder="telegram"
                  className="input-field text-sm"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-white mb-1">WebDAV URL</label>
                <input
                  type="text"
                  value={telegramUrl}
                  onChange={(e) => setTelegramUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8080/webdav"
                  className="input-field text-sm font-mono text-xs"
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-xs font-medium text-white mb-1">Username (Optional)</label>
                  <input
                    type="text"
                    value={telegramUser}
                    onChange={(e) => setTelegramUser(e.target.value)}
                    placeholder="user"
                    className="input-field text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-white mb-1">Password / Key (Optional)</label>
                  <input
                    type="password"
                    value={telegramPass}
                    onChange={(e) => setTelegramPass(e.target.value)}
                    placeholder="••••••••"
                    className="input-field text-sm"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-3">
                <button
                  type="button"
                  onClick={() => setShowTelegramModal(false)}
                  className="btn-secondary text-xs py-2 px-4"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isConnectingTelegram}
                  className="btn-primary text-xs py-2 px-4 flex items-center gap-1.5"
                >
                  {isConnectingTelegram && <Loader2 size={14} className="animate-spin" />}
                  <span>{isConnectingTelegram ? "Connecting…" : "Mount Remote"}</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function CloudJobsActivityList() {
  const jobsMap = useCloudTranscodeStore((s) => s.jobs);
  const clearCompleted = useCloudTranscodeStore((s) => s.clearCompletedJobs);
  const clearAll = useCloudTranscodeStore((s) => s.clearAllJobs);
  const removeJob = useCloudTranscodeStore((s) => s.removeJob);
  const jobs = useMemo(() => Object.values(jobsMap), [jobsMap]);

  if (jobs.length === 0) {
    return (
      <div className="p-4 rounded-lg bg-surface/30 border border-border text-center text-xs text-subtle">
        No active or recent cloud transcode jobs.
      </div>
    );
  }

  const sorted = [...jobs].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="space-y-2">
      <div className="divide-y divide-border/40 rounded-lg border border-border overflow-hidden bg-surface/20">
        {sorted.map((job) => (
          <div key={job.id} className="p-3 flex items-center justify-between text-xs gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-white truncate max-w-xs">{job.title}</span>
                <span
                  className={`text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border ${
                    job.status === "complete"
                      ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/40"
                      : job.status === "error"
                      ? "bg-red-950/40 text-red-400 border-red-800/40"
                      : "bg-accent/15 text-accent border-accent/30 animate-pulse"
                  }`}
                >
                  {job.status}
                </span>
              </div>
              <p className="text-[11px] font-mono text-subtle truncate mt-0.5">
                {job.destRemoteFolder}/{job.targetFilename}
              </p>
              {job.failureMessage && (
                <p className="text-[11px] text-danger/80 truncate mt-0.5">
                  {job.failureMessage}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {job.kernelUrl && (
                <a
                  href={job.kernelUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1"
                >
                  <span>{job.provider === "github_actions" ? "GitHub Actions" : "Kaggle"}</span>
                  <ExternalLink size={11} />
                </a>
              )}
              <button
                onClick={() => removeJob(job.id)}
                className="p-1.5 text-subtle hover:text-danger rounded hover:bg-white/5 transition-colors"
                title="Remove job"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-3 pt-1">
        <button
          onClick={clearCompleted}
          className="text-xs text-subtle hover:text-white transition-colors"
        >
          Clear Finished
        </button>
        <button
          onClick={() => {
            if (confirm("Clear all cloud transcode jobs from history?")) {
              clearAll();
            }
          }}
          className="text-xs text-danger/80 hover:text-danger transition-colors"
        >
          Clear All
        </button>
      </div>
    </div>
  );
}

function GoogleCastSettingsSection() {
  const {
    devices,
    selectedDevice,
    status,
    isScanning,
    scanDevices,
    addManualDevice,
    connect,
    disconnect,
    stop,
  } = useCastStore();

  const [manualIp, setManualIp] = useState("");
  const [manualName, setManualName] = useState("");
  const [connectingIp, setConnectingIp] = useState<string | null>(null);

  useEffect(() => {
    scanDevices();
  }, []);

  const handleConnect = async (device: CastDevice) => {
    setConnectingIp(device.ip);
    try {
      await connect(device);
    } catch (e) {
      console.error(e);
    } finally {
      setConnectingIp(null);
    }
  };

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualIp.trim()) return;
    setConnectingIp(manualIp.trim());
    try {
      await addManualDevice(manualIp.trim(), manualName.trim() || undefined);
      setManualIp("");
      setManualName("");
    } catch (e) {
      console.error(e);
    } finally {
      setConnectingIp(null);
    }
  };

  return (
    <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cast size={16} className="text-accent" />
          <h3 className="font-heading font-semibold text-white text-sm">
            Google Cast &amp; Chromecast Devices
          </h3>
        </div>
        <button
          onClick={scanDevices}
          disabled={isScanning}
          className="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1"
        >
          <RefreshCw size={11} className={isScanning ? "animate-spin" : ""} />
          <span>{isScanning ? "Scanning…" : "Scan LAN"}</span>
        </button>
      </div>

      <p className="text-xs text-subtle font-body">
        Wirelessly cast movies, TV shows, music, and audiobooks to Chromecast, Google TV, Android TV, and Google Nest speakers on your local network.
      </p>

      {/* Connected device banner */}
      {status.connected && selectedDevice && (
        <div className="p-3.5 rounded-lg bg-accent/10 border border-accent/30 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2.5">
            <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
            <div>
              <p className="font-semibold text-white">Connected: {selectedDevice.name}</p>
              <p className="text-[10px] text-subtle font-mono">{selectedDevice.ip}:{selectedDevice.port} &bull; State: {status.player_state}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={stop}
              className="btn-secondary text-xs py-1 px-2.5"
            >
              Stop
            </button>
            <button
              onClick={disconnect}
              className="text-xs text-red-400 hover:text-red-300 font-medium px-2 py-1"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}

      {/* Devices list */}
      <div className="space-y-2">
        {devices.length === 0 ? (
          <div className="p-4 rounded-lg bg-surface/30 border border-border text-center text-xs text-subtle">
            {isScanning ? "Scanning network for Chromecast devices…" : "No Google Cast devices found on local network."}
          </div>
        ) : (
          devices.map((d) => {
            const isConnected = selectedDevice?.ip === d.ip && status.connected;
            const isConnecting = connectingIp === d.ip;
            return (
              <div
                key={d.id}
                className="p-3 rounded-lg bg-surface/50 border border-border/80 flex items-center justify-between text-xs"
              >
                <div>
                  <p className="font-semibold text-white">{d.name}</p>
                  <p className="text-[10px] text-subtle font-mono">{d.model} &bull; {d.ip}:{d.port}</p>
                </div>
                {isConnected ? (
                  <span className="text-[11px] text-accent font-semibold px-2 py-0.5 rounded bg-accent/20">
                    Connected
                  </span>
                ) : (
                  <button
                    onClick={() => handleConnect(d)}
                    disabled={isConnecting}
                    className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
                  >
                    {isConnecting && <Loader2 size={11} className="animate-spin" />}
                    <span>{isConnecting ? "Connecting…" : "Connect"}</span>
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Manual IP connect */}
      <form onSubmit={handleManualAdd} className="pt-2 border-t border-border/60 flex items-center gap-2">
        <input
          type="text"
          value={manualName}
          onChange={(e) => setManualName(e.target.value)}
          placeholder="Name (optional)"
          className="input-field text-xs w-36"
        />
        <input
          type="text"
          value={manualIp}
          onChange={(e) => setManualIp(e.target.value)}
          placeholder="Device IP (e.g. 192.168.1.50)"
          className="input-field text-xs font-mono flex-1"
          required
        />
        <button
          type="submit"
          disabled={!manualIp.trim() || connectingIp === manualIp.trim()}
          className="btn-secondary text-xs py-2 px-3 shrink-0 flex items-center gap-1"
        >
          <Plus size={12} />
          <span>Add &amp; Connect</span>
        </button>
      </form>
    </div>
  );
}

function StreamtapeSettingsSection() {
  const {
    streamtapeConfig,
    setStreamtapeConfig,
    doodstreamConfig,
    setDoodstreamConfig,
    dropmbConfig,
    setDropmbConfig,
    catboxConfig,
    setCatboxConfig,
    keepAliveConfig,
    setKeepAliveConfig,
    libraries,
    rcloneConfigPath,
  } = useAppStore();
  const addToast = useToastStore((s) => s.addToast);

  const [enabled, setEnabled] = useState(streamtapeConfig?.enabled ?? false);
  const [apiLogin, setApiLogin] = useState(streamtapeConfig?.apiLogin ?? "");
  const [apiKey, setApiKey] = useState(streamtapeConfig?.apiKey ?? "");
  const [autoOffload, setAutoOffload] = useState(streamtapeConfig?.autoOffload ?? false);
  const [selectedLibraries, setSelectedLibraries] = useState<string[]>(
    streamtapeConfig?.autoOffloadLibraries ?? []
  );
  const [saved, setSaved] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<{ running: boolean; port: number; streamtape_configured: boolean; error?: string } | null>(null);
  const [manualOffloading, setManualOffloading] = useState(false);

  // DoodStream Tier 2 Relay State
  const [doodEnabled, setDoodEnabled] = useState(doodstreamConfig?.enabled ?? false);
  const [doodApiKey, setDoodApiKey] = useState(doodstreamConfig?.apiKey ?? "");
  const [doodAutoMirror, setDoodAutoMirror] = useState(doodstreamConfig?.autoMirror ?? true);
  const [doodSaved, setDoodSaved] = useState(false);

  // DropMB Cloud Offload Account State
  const [dropmbEnabled, setDropmbEnabled] = useState(dropmbConfig?.enabled ?? false);
  const [dropmbEmail, setDropmbEmail] = useState(dropmbConfig?.email ?? "");
  const [dropmbPassword, setDropmbPassword] = useState(dropmbConfig?.password ?? "");
  const [dropmbToken, setDropmbToken] = useState(dropmbConfig?.token ?? "");
  const [authenticatingDropmb, setAuthenticatingDropmb] = useState(false);
  const [dropmbStatusMessage, setDropmbStatusMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Catbox.moe Opt-In Offload State
  const [catboxEnabled, setCatboxEnabled] = useState(catboxConfig?.enabled ?? false);
  const [catboxUserhash, setCatboxUserhash] = useState(catboxConfig?.userhash ?? "");
  const [catboxSaved, setCatboxSaved] = useState(false);
  const [dropmbSaved, setDropmbSaved] = useState(false);

  // Autonomous Keep-Alive Bot State
  const [botEnabled, setBotEnabled] = useState(keepAliveConfig?.enabled ?? true);
  const [botMetrics, setBotMetrics] = useState<KeepAliveStats>(() => getKeepAliveMetrics());
  const [runningBot, setRunningBot] = useState(false);

  const checkStatus = async () => {
    try {
      const res = await invoke<{ running: boolean; port: number; streamtape_configured: boolean; error?: string }>("get_alist_status");
      setStatus(res);
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void checkStatus();
    const interval = setInterval(checkStatus, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleSaveAndConnect = async () => {
    setConnecting(true);
    setSaved(false);
    try {
      const newConfig = {
        enabled,
        apiLogin: apiLogin.trim(),
        apiKey: apiKey.trim(),
        autoOffload,
        autoOffloadLibraries: selectedLibraries,
      };
      setStreamtapeConfig(newConfig);

      if (enabled && apiLogin.trim() && apiKey.trim()) {
        await invoke("start_alist_daemon", {
          configPath: rcloneConfigPath,
          apiLogin: apiLogin.trim(),
          apiKey: apiKey.trim(),
        });
        await checkStatus();
        addToast("AList daemon started & Streamtape WebDAV backend configured!", "success");
      } else if (!enabled) {
        await invoke("stop_alist_daemon").catch(() => {});
        await checkStatus();
        addToast("Streamtape offloading disabled", "info");
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      console.error("Failed configuring Streamtape / AList:", err);
      addToast(`Streamtape configuration failed: ${err?.message || err}`, "error");
    } finally {
      setConnecting(false);
    }
  };

  const handleRunOffloadNow = async () => {
    setManualOffloading(true);
    try {
      addToast("Starting background Streamtape offload session...", "info");
      await runAutoStreamtapeOffload(60);
      addToast("Streamtape offload session completed", "success");
    } catch (err) {
      addToast(`Streamtape offload error: ${err}`, "error");
    } finally {
      setManualOffloading(false);
    }
  };

  const handleSaveDoodstream = () => {
    setDoodstreamConfig({
      enabled: doodEnabled,
      apiKey: doodApiKey.trim(),
      autoMirror: doodAutoMirror,
    });
    setDoodSaved(true);
    addToast("DoodStream relay settings saved!", "success");
    setTimeout(() => setDoodSaved(false), 2500);
  };

  const handleSaveDropmb = () => {
    setDropmbConfig({
      enabled: dropmbEnabled,
      email: dropmbEmail.trim(),
      password: dropmbPassword,
      token: dropmbToken.trim(),
    });
    setDropmbSaved(true);
    addToast("DropMB settings saved!", "success");
    setTimeout(() => setDropmbSaved(false), 2500);
  };

  const handleSignInDropmb = async () => {
    if (!dropmbEmail.trim() || !dropmbPassword) {
      setDropmbStatusMessage({ ok: false, text: "Please enter your DropMB email and password." });
      return;
    }
    setAuthenticatingDropmb(true);
    setDropmbStatusMessage(null);
    try {
      const res = await signIntoDropmb(dropmbEmail.trim(), dropmbPassword);
      if (res.ok && res.token) {
        setDropmbToken(res.token);
        setDropmbEnabled(true);
        setDropmbStatusMessage({ ok: true, text: `Connected to DropMB! Session token verified.` });
        addToast("Successfully authenticated with DropMB!", "success");
      } else {
        setDropmbStatusMessage({ ok: false, text: res.message || "Authentication failed." });
        addToast(`DropMB sign-in failed: ${res.message}`, "error");
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      setDropmbStatusMessage({ ok: false, text: msg });
      addToast(`DropMB sign-in error: ${msg}`, "error");
    } finally {
      setAuthenticatingDropmb(false);
    }
  };

  const handleRunBotNow = async () => {
    setRunningBot(true);
    try {
      addToast("Scanning cyberlocker files and pinging keep-alive beacons...", "info");
      const res = await runKeepAliveHealthCheck({ forceCheck: true });
      setBotMetrics(getKeepAliveMetrics());
      addToast(`Keep-Alive Bot: Verified ${res.eligibleTotal} files. Pinged beacons for ${res.visitedCount} streams!`, "success");
    } catch (err: any) {
      addToast(`Keep-Alive Bot check failed: ${err?.message || err}`, "error");
    } finally {
      setRunningBot(false);
    }
  };

  useEffect(() => {
    setBotMetrics(getKeepAliveMetrics());
    const interval = setInterval(() => {
      setBotMetrics(getKeepAliveMetrics());
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const toggleLibrary = (libId: string) => {
    setSelectedLibraries((prev) =>
      prev.includes(libId) ? prev.filter((id) => id !== libId) : [...prev, libId]
    );
  };

  const videoLibraries = libraries.filter(
    (l) => l.type === "movies" || l.type === "tv"
  );

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
            <Film size={18} />
          </div>
          <h2 className="font-display text-3xl text-bright tracking-wide">STREAMTAPE CDN &amp; ALIST ENGINE</h2>
        </div>
        <p className="text-subtle font-body text-sm mt-1">
          Bundle headless AList to host a high-performance Streamtape WebDAV backend. Offload video playback from paid/rate-limited cloud remotes (like OpenDrive, Google Drive, or OneDrive) directly to Streamtape CDN without duplicating library items.
        </p>
      </div>

      {/* AList Daemon Status Banner */}
      <div className="bg-panel border border-border rounded-xl p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${status?.running ? "bg-emerald-400 animate-pulse" : "bg-neutral-600"}`} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">AList Daemon Engine</span>
              <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                status?.running
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  : "bg-neutral-800 text-neutral-400 border-neutral-700"
              }`}>
                {status?.running ? `Running on port ${status.port}` : "Stopped"}
              </span>
            </div>
            <p className="text-xs text-subtle mt-0.5">
              {status?.running && status?.streamtape_configured
                ? "Streamtape WebDAV mounted at /streamtape · rclone [streamtape] ready"
                : status?.running
                ? "AList running; waiting for Streamtape API credentials"
                : "Daemon starts automatically when Streamtape offloading is enabled"}
            </p>
          </div>
        </div>

        {status?.running && (
          <button
            type="button"
            onClick={async () => {
              await invoke("stop_alist_daemon").catch(() => {});
              await checkStatus();
              addToast("AList daemon stopped", "info");
            }}
            className="btn-secondary text-xs py-1.5 px-3"
          >
            Stop Daemon
          </button>
        )}
      </div>

      {/* Main Settings Card */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <span className="text-sm font-semibold text-white">Enable Streamtape CDN Offloading</span>
            <p className="text-xs text-subtle mt-0.5">
              Automatically routes video playback to Streamtape CDN when available, saving your remote storage bandwidth.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`w-11 h-6 rounded-full transition-colors relative ${
              enabled ? "bg-accent" : "bg-white/10"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-subtle">API Login / User ID</span>
              <a
                href="https://streamtape.com/acc_details"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-accent hover:underline flex items-center gap-1"
              >
                <span>streamtape.com/acc_details</span>
                <ExternalLink size={10} />
              </a>
            </div>
            <input
              type="text"
              value={apiLogin}
              onChange={(e) => setApiLogin(e.target.value)}
              placeholder="e.g. 7c9a419df9b3a763"
              className="input-field text-xs font-mono w-full"
            />
          </div>

          <div>
            <span className="text-xs font-medium text-subtle block mb-1.5">API Key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste your Streamtape API key"
              className="input-field text-xs font-mono w-full"
            />
          </div>

          {/* Auto-offload settings */}
          <div className="pt-3 border-t border-border space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-white">Automatic Background Offloader</span>
                <p className="text-[11px] text-subtle mt-0.5 max-w-md">
                  Pushes newest video library additions to Streamtape in the background. Runs for up to 1 hour per session with single-transfer throttling to protect cloud API quotas.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAutoOffload(!autoOffload)}
                className={`w-11 h-6 rounded-full transition-colors relative ${
                  autoOffload ? "bg-accent" : "bg-white/10"
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                    autoOffload ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {autoOffload && videoLibraries.length > 0 && (
              <div className="bg-surface/50 rounded-lg p-3 space-y-2 border border-border">
                <span className="text-xs font-medium text-subtle block">Target Libraries for Auto-Offload</span>
                <div className="grid grid-cols-2 gap-2">
                  {videoLibraries.map((lib) => {
                    const isSelected = selectedLibraries.length === 0 || selectedLibraries.includes(lib.id);
                    return (
                      <label
                        key={lib.id}
                        className="flex items-center gap-2 text-xs text-text cursor-pointer select-none"
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleLibrary(lib.id)}
                          className="rounded border-border bg-panel text-accent focus:ring-0"
                        />
                        <span className="truncate">{lib.name} ({lib.type.toUpperCase()})</span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-[10px] text-subtle italic">
                  Leave all checked or specify particular libraries to offload.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
          <button
            type="button"
            onClick={handleSaveAndConnect}
            disabled={connecting}
            className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
          >
            {connecting ? (
              <Loader2 size={14} className="animate-spin text-void" />
            ) : saved ? (
              <Check size={14} />
            ) : (
              <Save size={14} />
            )}
            <span>{connecting ? "Connecting..." : saved ? "Saved & Connected" : "Save & Connect"}</span>
          </button>

          {enabled && apiLogin.trim() && apiKey.trim() && (
            <button
              type="button"
              onClick={handleRunOffloadNow}
              disabled={manualOffloading}
              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-amber-400 border-amber-500/30 hover:border-amber-400"
              title="Trigger a 1-hour background offload batch for newest items right now"
            >
              {manualOffloading ? (
                <Loader2 size={14} className="animate-spin text-amber-400" />
              ) : (
                <CloudUpload size={14} />
              )}
              <span>{manualOffloading ? "Offloading..." : "Run Offload Now"}</span>
            </button>
          )}
        </div>
      </div>

      {/* Card 2: DoodStream CDN Relay (Tier 2 Rolling Relay & Cloud Clone) */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">DoodStream CDN Relay (Tier 2)</span>
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                60-Day Expiry Relay
              </span>
            </div>
            <p className="text-xs text-subtle mt-0.5">
              Pairs with Streamtape as a dual-host rolling relay. Supports cloud-to-cloud remote URL cloning with 0 MB local bandwidth.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDoodEnabled(!doodEnabled)}
            className={`w-11 h-6 rounded-full transition-colors relative ${
              doodEnabled ? "bg-accent" : "bg-white/10"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                doodEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-subtle">DoodStream API Key</span>
              <a
                href="https://doodapi.co"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-accent hover:underline flex items-center gap-1"
              >
                <span>doodapi.co / doodstream.com</span>
                <ExternalLink size={10} />
              </a>
            </div>
            <input
              type="password"
              value={doodApiKey}
              onChange={(e) => setDoodApiKey(e.target.value)}
              placeholder="Paste your DoodStream / DoodAPI key"
              className="input-field text-xs font-mono w-full"
            />
          </div>

          <div className="pt-2 border-t border-border flex items-center justify-between">
            <div>
              <span className="text-xs font-semibold text-white">Automatic Cloud-to-Cloud Mirror</span>
              <p className="text-[11px] text-subtle mt-0.5 max-w-md">
                When videos are pushed to Streamtape, automatically clones them to DoodStream servers with 0 MB local bandwidth consumption.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDoodAutoMirror(!doodAutoMirror)}
              className={`w-11 h-6 rounded-full transition-colors relative ${
                doodAutoMirror ? "bg-accent" : "bg-white/10"
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                  doodAutoMirror ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>

          <div className="pt-3 border-t border-border flex justify-end">
            <button
              type="button"
              onClick={handleSaveDoodstream}
              className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
            >
              {doodSaved ? <Check size={14} /> : <Save size={14} />}
              <span>{doodSaved ? "Saved" : "Save DoodStream Settings"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Card: DropMB Cloud Offload (Pingvin Share Account) */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">DropMB Cloud Offload</span>
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                100-Day Inactivity Lease · Pingvin Share
              </span>
            </div>
            <p className="text-xs text-subtle mt-0.5">
              100-day rolling cloud caching for audiobooks, music, and documents (refreshed automatically on playback and via Keep-Alive maintenance bot). Because anonymous uploads were disabled by DropMB, configure your free account or session token below.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDropmbEnabled(!dropmbEnabled)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              dropmbEnabled ? "bg-accent" : "bg-white/10"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                dropmbEnabled ? "translate-x-5 bg-void" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        <div className="space-y-3 font-body">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs font-medium text-subtle">DropMB Email</span>
                <a
                  href="https://dropmb.com/auth/signUp"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-accent hover:underline flex items-center gap-1"
                >
                  <span>Create Account</span>
                  <ExternalLink size={10} />
                </a>
              </div>
              <input
                type="email"
                value={dropmbEmail}
                onChange={(e) => setDropmbEmail(e.target.value)}
                placeholder="DropMB account email"
                className="input-field text-xs w-full"
              />
            </div>
            <div>
              <span className="text-xs font-medium text-subtle block mb-1.5">DropMB Password</span>
              <input
                type="password"
                value={dropmbPassword}
                onChange={(e) => setDropmbPassword(e.target.value)}
                placeholder="Account password"
                className="input-field text-xs w-full"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-subtle">Direct Session Token / Cookie (Optional)</span>
              <span className="text-[10px] text-subtle">For OAuth or 2FA users</span>
            </div>
            <input
              type="password"
              value={dropmbToken}
              onChange={(e) => setDropmbToken(e.target.value)}
              placeholder="Paste access_token JWT or cookie value directly"
              className="input-field text-xs font-mono w-full"
            />
          </div>

          {dropmbStatusMessage && (
            <div
              className={`text-xs p-3 rounded-lg border flex items-center gap-2 ${
                dropmbStatusMessage.ok
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
                  : "bg-danger/10 border-danger/30 text-danger"
              }`}
            >
              {dropmbStatusMessage.ok ? <Check size={14} /> : <AlertCircle size={14} />}
              <span>{dropmbStatusMessage.text}</span>
            </div>
          )}

          <div className="pt-3 border-t border-border flex items-center justify-between">
            <button
              type="button"
              onClick={handleSignInDropmb}
              disabled={authenticatingDropmb || !dropmbEmail.trim() || !dropmbPassword}
              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-cyan-400 border-cyan-500/30 hover:border-cyan-400 disabled:opacity-50"
            >
              {authenticatingDropmb ? (
                <Loader2 size={14} className="animate-spin text-cyan-400" />
              ) : (
                <Key size={14} />
              )}
              <span>{authenticatingDropmb ? "Authenticating..." : "Sign In & Get Token"}</span>
            </button>

            <button
              type="button"
              onClick={handleSaveDropmb}
              className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
            >
              {dropmbSaved ? <Check size={14} /> : <Save size={14} />}
              <span>{dropmbSaved ? "Saved" : "Save DropMB Settings"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Card: Catbox.moe Offload (Opt-In, Public URLs) */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">Catbox.moe Offload (200 MB Max)</span>
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Public Links
              </span>
            </div>
            <p className="text-xs text-subtle mt-0.5">
              Opt-in direct hotlink offload for music, books, comics, and photos (&le; 200 MB). Uploaded files get a public{" "}
              <code className="font-mono text-bright">https://files.catbox.moe/...</code> URL accessible to anyone with the link. Only files uploaded with a{" "}
              <code className="font-mono text-bright">userhash</code> can later be deleted.
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={catboxEnabled}
              onChange={(e) => setCatboxEnabled(e.target.checked)}
              className="rounded border-border text-accent focus:ring-0"
            />
            <span className="text-xs text-white font-semibold">Enable</span>
          </label>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-subtle block mb-1.5">
              Catbox Userhash (Optional — required if you want to delete uploads later)
            </label>
            <input
              type="password"
              value={catboxUserhash}
              onChange={(e) => setCatboxUserhash(e.target.value)}
              placeholder="Optional Catbox account userhash"
              className="input-field w-full text-xs font-mono"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              setCatboxConfig({ enabled: catboxEnabled, userhash: catboxUserhash.trim() });
              setCatboxSaved(true);
              addToast("Saved Catbox.moe offload settings", "success");
              setTimeout(() => setCatboxSaved(false), 2000);
            }}
            className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
          >
            {catboxSaved ? <Check size={14} /> : <Save size={14} />}
            <span>{catboxSaved ? "Saved" : "Save Catbox Settings"}</span>
          </button>
        </div>
      </div>

      {/* Card 3: Autonomous Keep-Alive Bot Engine */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">Autonomous Keep-Alive Bot</span>
              <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                Ad Beacon Engine
              </span>
            </div>
            <p className="text-xs text-subtle mt-0.5">
              Performs silent, audio-muted sandboxed iframe pings on Day 25–28 to execute host JavaScript and analytics beacons, resetting the inactivity timer to Day 0.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !botEnabled;
              setBotEnabled(next);
              setKeepAliveConfig({ enabled: next });
              addToast(next ? "Keep-Alive Bot enabled" : "Keep-Alive Bot disabled", "info");
            }}
            className={`w-11 h-6 rounded-full transition-colors relative ${
              botEnabled ? "bg-accent" : "bg-white/10"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                botEnabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Live Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-surface/50 rounded-lg p-3 border border-border text-center">
          <div>
            <span className="text-[11px] text-subtle block">Active Relays</span>
            <span className="text-base font-bold font-mono text-white">{botMetrics.totalCyberlockerItems}</span>
          </div>
          <div>
            <span className="text-[11px] text-subtle block">Nearing Day 25+</span>
            <span className={`text-base font-bold font-mono ${botMetrics.nearingExpiryCount > 0 ? "text-amber-400" : "text-emerald-400"}`}>
              {botMetrics.nearingExpiryCount}
            </span>
          </div>
          <div>
            <span className="text-[11px] text-subtle block">Beacons Fired</span>
            <span className="text-base font-bold font-mono text-accent">{botMetrics.totalKeptAlive}</span>
          </div>
          <div>
            <span className="text-[11px] text-subtle block">Last Run</span>
            <span className="text-xs font-mono text-subtle">
              {botMetrics.lastRunAt ? new Date(botMetrics.lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : "Never"}
            </span>
          </div>
        </div>

        {/* Account-wide Streamtape Crawl toggle */}
        <div className="pt-2 border-t border-border flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-white">Account-Wide Streamtape Sweep</span>
            <p className="text-[11px] text-subtle mt-0.5 max-w-md">
              Automatically discovers and pings all files across your entire Streamtape account via API (including files uploaded outside media libraries) to prevent 30-day inactivity expiration.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              const current = keepAliveConfig?.accountWideStreamtape ?? false;
              setKeepAliveConfig({ accountWideStreamtape: !current });
              addToast(!current ? "Account-wide Streamtape sweep enabled" : "Account-wide Streamtape sweep disabled", "info");
            }}
            className={`w-11 h-6 rounded-full transition-colors relative ${
              keepAliveConfig?.accountWideStreamtape ? "bg-accent" : "bg-white/10"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                keepAliveConfig?.accountWideStreamtape ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <p className="text-[11px] text-subtle italic">
            Popups, sound, and navigation are strictly blocked by iframe sandboxing.
          </p>
          <button
            type="button"
            onClick={handleRunBotNow}
            disabled={runningBot}
            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-emerald-400 border-emerald-500/30 hover:border-emerald-400"
            title="Scan cyberlocker files and silently refresh any nearing inactivity expiry"
          >
            {runningBot ? (
              <Loader2 size={14} className="animate-spin text-emerald-400" />
            ) : (
              <RefreshCw size={14} />
            )}
            <span>{runningBot ? "Pinging Beacons..." : "Run Health Check Now"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function TelegramSettingsSection() {
  const telegramConfig = useAppStore((s) => s.telegramConfig);
  const setTelegramConfig = useAppStore((s) => s.setTelegramConfig);
  const rcloneConfigPath = useAppStore((s) => s.rcloneConfigPath);
  const remotes = useAppStore((s) => s.remotes);
  const addToast = useToastStore((s) => s.addToast);

  const [enabled, setEnabled] = useState(telegramConfig?.enabled ?? false);
  const [botToken, setBotToken] = useState(telegramConfig?.botToken ?? "");
  const [chatId, setChatId] = useState(telegramConfig?.chatId ?? "");
  const [apiId, setApiId] = useState(telegramConfig?.apiId ?? "");
  const [apiHash, setApiHash] = useState(telegramConfig?.apiHash ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [mountingTgNative, setMountingTgNative] = useState(false);

  const isTgNativeMounted = remotes.some((r) => r.name === "tg-native");
  const isTgDriveMounted = remotes.some((r) => r.name === "telegram-drive");

  const [tdDesktopStatus, setTdDesktopStatus] = useState<{
    detected: boolean;
    path?: string | null;
    folders_count: number;
    files_count: number;
    folders?: { id: number; name: string; chat_id: string }[];
    webdav_url: string;
    is_running: boolean;
  } | null>(null);
  const [syncingDesktop, setSyncingDesktop] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
      invoke<any>("telegram_get_desktop_status")
        .then(setTdDesktopStatus)
        .catch(() => {});
    }
  }, []);

  const handleImportAndMountDesktop = async () => {
    setSyncingDesktop(true);
    try {
      const status = await invoke<any>("telegram_import_desktop_app");
      setTdDesktopStatus(status);
      const targetUrl = status?.webdav_url || "http://127.0.0.1:8551/dav/";
      const updated = await rcloneCreateWebdavRemote(
        rcloneConfigPath,
        "telegram-drive",
        targetUrl,
        undefined,
        undefined
      );
      useAppStore.getState().setRemotes(updated.map((r) => ({ name: r.name, type: r.remote_type })));
      await invoke("telegram_sync_index", { chatId: null }).catch(() => {});
      const refreshed = await invoke<any>("telegram_get_desktop_status").catch(() => status);
      setTdDesktopStatus(refreshed);
      addToast(
        `Synced Telegram Drive Desktop (${refreshed?.folders_count ?? 0} folders, ${refreshed?.files_count ?? 0} files) on port 8551!`,
        "success"
      );
    } catch (e: any) {
      addToast(`Failed to import Telegram Drive Desktop: ${e?.message || e}`, "error");
    } finally {
      setSyncingDesktop(false);
    }
  };

  const handleSave = async () => {
    setTelegramConfig({
      enabled,
      botToken: botToken.trim(),
      chatId: chatId.trim(),
      apiId: apiId.trim(),
      apiHash: apiHash.trim(),
    });
    try {
      if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
        await invoke("telegram_configure_and_connect", {
          apiId: apiId.trim() ? parseInt(apiId.trim(), 10) : null,
          apiHash: apiHash.trim() || null,
          botToken: botToken.trim() || null,
          defaultChatId: chatId.trim() || null,
        });
      }
    } catch (e) {
      console.warn("Failed to configure native Telegram MTProto engine:", e);
    }
    setSaved(true);
    addToast("Telegram settings saved & native engine connected", "success");
    setTimeout(() => setSaved(false), 3000);
  };

  const handleMountTgNative = async () => {
    setMountingTgNative(true);
    try {
      if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
        await invoke("telegram_configure_and_connect", {
          apiId: apiId.trim() ? parseInt(apiId.trim(), 10) : null,
          apiHash: apiHash.trim() || null,
          botToken: botToken.trim() || null,
          defaultChatId: chatId.trim() || null,
        });
        const updated = await rcloneCreateWebdavRemote(
          rcloneConfigPath,
          "tg-native",
          "http://127.0.0.1:8552/webdav",
          undefined,
          undefined
        );
        useAppStore.getState().setRemotes(updated.map((r) => ({ name: r.name, type: r.remote_type })));
        addToast("Successfully mounted native Telegram WebDAV as 'tg-native:'", "success");
      }
    } catch (e: any) {
      addToast(`Failed to mount tg-native: ${e?.message || e}`, "error");
    } finally {
      setMountingTgNative(false);
    }
  };

  const handleTestConnection = async () => {
    const token = botToken.trim();
    if (!token) {
      addToast("Please enter a Telegram Bot Token first", "error");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.description || "Invalid bot token");
      }
      const botUsername = data.result?.username ? `@${data.result.username}` : "Bot";

      if (chatId.trim()) {
        const msgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId.trim(),
            text: `🔔 RcloneFlix connected successfully!\nBot: ${botUsername}\nCloud offload engine is ready (up to 2 GB per file via Kaggle MTProto).`,
          }),
        });
        const msgData = await msgRes.json();
        if (!msgData.ok) {
          addToast(`Bot token valid (${botUsername}), but failed to message Chat ID: ${msgData.description}`, "error");
          return;
        }
        addToast(`Telegram connection verified! Test message sent by ${botUsername}`, "success");
      } else {
        addToast(`Telegram bot verified: ${botUsername}. Enter a Chat ID to test message delivery.`, "success");
      }
    } catch (err: any) {
      addToast(`Telegram test failed: ${err.message || err}`, "error");
    } finally {
      setTesting(false);
    }
  };

  const isConfigured = Boolean(botToken.trim() && chatId.trim());

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
            <Send size={18} />
          </div>
          <h2 className="font-display text-3xl text-bright tracking-wide">TELEGRAM CLOUD OFFLOAD</h2>
        </div>
        <p className="text-subtle font-body text-sm mt-1">
          Offload media files (up to 2,000 MB per file) and direct Web URLs straight into Telegram chats, channels, or private storage. Transfers execute 100% in the cloud via headless Kaggle workers with 0 MB local bandwidth consumption.
        </p>
      </div>

      {/* Status Banner */}
      <div className="bg-panel border border-border rounded-xl p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${isConfigured ? "bg-emerald-400 animate-pulse" : "bg-neutral-600"}`} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">Telegram Offload Engine</span>
              <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                isConfigured
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  : "bg-neutral-800 text-neutral-400 border-neutral-700"
              }`}>
                {isConfigured ? "Configured & Ready" : "Setup Required"}
              </span>
            </div>
            <p className="text-xs text-subtle mt-0.5">
              {isConfigured
                ? `Ready to offload files up to 2 GB directly to ${chatId}`
                : "Enter Bot Token and Target Chat ID to enable cloud-to-telegram offloading"}
            </p>
          </div>
        </div>
      </div>

      {/* Main Settings Card */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <span className="text-sm font-semibold text-white">Enable Telegram Offload Engine</span>
            <p className="text-xs text-subtle mt-0.5">
              Enables Telegram as a direct cloud transfer destination in Cloud Explorer and URL Offloader.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEnabled(!enabled)}
            className={`w-11 h-6 rounded-full transition-colors relative ${
              enabled ? "bg-accent" : "bg-white/10"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-subtle">Bot Token</span>
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-accent hover:underline flex items-center gap-1"
              >
                <span>Get token from @BotFather</span>
                <ExternalLink size={10} />
              </a>
            </div>
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="e.g. 123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ"
              className="input-field text-xs font-mono w-full"
            />
            <p className="text-[11px] text-subtle mt-1">
              Create a free bot on Telegram by sending <code className="text-accent">/newbot</code> to <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline">@BotFather</a>.
            </p>
          </div>

          <div>
            <span className="text-xs font-medium text-subtle block mb-1.5">Target Chat / Channel ID</span>
            <input
              type="text"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="e.g. @my_channel or -1001234567890 or your User ID"
              className="input-field text-xs font-mono w-full"
            />
            <p className="text-[11px] text-subtle mt-1">
              For public channels, enter <code className="text-accent">@channel_username</code> (add the bot as admin). For private channels/groups, enter the ID starting with <code className="text-accent">-100...</code>. For private messages, enter your personal numeric Telegram User ID.
            </p>
          </div>

          {/* Advanced Telethon MTProto Options */}
          <div className="pt-3 border-t border-border">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center justify-between w-full text-xs font-medium text-subtle hover:text-white transition-colors"
            >
              <span>Advanced MTProto Credentials (2 GB Upload Support)</span>
              <span>{showAdvanced ? "▲" : "▼"}</span>
            </button>

            {showAdvanced && (
              <div className="mt-3 p-3 rounded-lg bg-surface/40 border border-border space-y-3">
                <p className="text-[11px] text-subtle">
                  Standard Bot API caps uploads at 50 MB. RcloneFlix cloud workers use <strong>Telethon MTProto</strong> to enable <strong>2,000 MB (2 GB)</strong> uploads. Telegram Desktop open-source credentials are used by default, but you may supply custom credentials from <a href="https://my.telegram.org" target="_blank" rel="noreferrer" className="text-accent hover:underline">my.telegram.org</a>.
                </p>
                <div>
                  <label className="text-[11px] text-subtle block mb-1">Telegram API ID (Optional)</label>
                  <input
                    type="text"
                    value={apiId}
                    onChange={(e) => setApiId(e.target.value)}
                    placeholder="Default: 2040 (Telegram Desktop)"
                    className="input-field text-xs font-mono w-full"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-subtle block mb-1">Telegram API Hash (Optional)</label>
                  <input
                    type="password"
                    value={apiHash}
                    onChange={(e) => setApiHash(e.target.value)}
                    placeholder="Default: Official Desktop Hash"
                    className="input-field text-xs font-mono w-full"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
          <button
            type="button"
            onClick={handleSave}
            className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            <span>{saved ? "Saved" : "Save Telegram Settings"}</span>
          </button>

          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testing || !botToken.trim()}
            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-accent border-accent/30 hover:border-accent disabled:opacity-50"
            title="Send a verification ping to Telegram"
          >
            {testing ? (
              <Loader2 size={14} className="animate-spin text-accent" />
            ) : (
              <Send size={14} />
            )}
            <span>{testing ? "Testing..." : "Test Bot Connection"}</span>
          </button>
        </div>
      </div>

      {/* Telegram Drive Desktop App Emulation (caamer20/Telegram-Drive) */}
      <div className="bg-panel border border-accent/30 rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <Folder size={16} className="text-accent" />
              <span className="text-sm font-semibold text-white">
                Telegram Drive Desktop App (Port 8551)
              </span>
              <span
                className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                  tdDesktopStatus?.is_running
                    ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                    : "bg-neutral-800 text-neutral-400 border-neutral-700"
                }`}
              >
                {tdDesktopStatus?.is_running
                  ? `Active (${tdDesktopStatus.folders_count} Folders · ${tdDesktopStatus.files_count} Files)`
                  : isTgDriveMounted
                  ? "Mounted (App Offline)"
                  : "Offline"}
              </span>
            </div>
            <p className="text-xs text-subtle mt-1">
              Integrates directly with the official Telegram Drive desktop application via local WebDAV on port 8551. The official Telegram Drive desktop app must be running to stream telegram-drive: remotes.
            </p>
          </div>
          <button
            type="button"
            onClick={handleImportAndMountDesktop}
            disabled={syncingDesktop}
            className="btn-accent text-xs py-2 px-3.5 flex items-center gap-1.5 shrink-0 disabled:opacity-50"
          >
            {syncingDesktop ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            <span>{isTgDriveMounted ? "Sync & Refresh Desktop Drive" : "Import & Mount Desktop Drive"}</span>
          </button>
        </div>

        {tdDesktopStatus?.folders && tdDesktopStatus.folders.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[11px] text-subtle font-semibold uppercase tracking-wider">
              Reproduced Desktop Folders ({tdDesktopStatus.folders.length})
            </span>
            <div className="flex flex-wrap gap-1.5">
              {tdDesktopStatus.folders.map((f) => (
                <span
                  key={`${f.id}-${f.name}`}
                  className="px-2.5 py-1 rounded-lg bg-surface border border-border text-xs text-white flex items-center gap-1.5"
                >
                  <Folder size={12} className="text-accent" />
                  <span>{f.name}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="text-[11px] font-mono text-subtle bg-surface/40 p-2.5 rounded-lg border border-border flex items-center justify-between">
          <span className="truncate pr-2">
            Endpoint: <code className="text-white">{tdDesktopStatus?.webdav_url || "http://127.0.0.1:8551/dav/"}</code>
          </span>
          {tdDesktopStatus?.is_running ? (
            <span className="text-emerald-400 text-[10px] shrink-0">● Desktop App Connected (Port 8551)</span>
          ) : (
            <span className="text-amber-400 text-[10px] shrink-0">○ Desktop App Offline (Port 8551)</span>
          )}
        </div>
      </div>

      {/* Native Embedded MTProto & WebDAV Bridge Card */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-accent" />
              <span className="text-sm font-semibold text-white">Native MTProto &amp; WebDAV Bridge</span>
              <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                isTgNativeMounted
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  : "bg-neutral-800 text-neutral-400 border-neutral-700"
              }`}>
                {isTgNativeMounted ? "Mounted (tg-native:)" : "Unmounted"}
              </span>
            </div>
            <p className="text-xs text-subtle mt-0.5">
              Streams and lists Telegram media messages via the internal Rust MTProto engine on port 8552. Never touches or conflicts with your external port 8551 service.
            </p>
          </div>
          <button
            type="button"
            onClick={handleMountTgNative}
            disabled={mountingTgNative}
            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-accent border border-accent/30 hover:border-accent disabled:opacity-50"
          >
            {mountingTgNative ? (
              <Loader2 size={13} className="animate-spin text-accent" />
            ) : (
              <HardDrive size={13} />
            )}
            <span>{isTgNativeMounted ? "Remount tg-native" : "1-Click Mount tg-native"}</span>
          </button>
        </div>
        <div className="text-[11px] font-mono text-subtle bg-surface/40 p-2.5 rounded-lg border border-border flex items-center justify-between">
          <span>Local Endpoint: <code className="text-white">http://127.0.0.1:8552/webdav</code></span>
          <span className="text-neutral-500 text-[10px]">Zero bandwidth · Local Range Seeking</span>
        </div>
      </div>
    </div>
  );
}

function UdropSettingsSection() {
  const rcloneConfigPath = useAppStore((s) => s.rcloneConfigPath);
  const rcloneConfigContent = useAppStore((s) => s.rcloneConfigContent);
  const addToast = useToastStore((s) => s.addToast);
  const [config, setConfig] = useState(loadUdropConfig());
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [mounting, setMounting] = useState(false);
  const [accountInfo, setAccountInfo] = useState<UdropAccountInfo | null>(null);

  const handleSave = () => {
    saveUdropConfig(config);
    setSaved(true);
    addToast("uDrop settings saved", "success");
    setTimeout(() => setSaved(false), 3000);
  };

  const handleTestAccount = async () => {
    setTesting(true);
    try {
      saveUdropConfig(config);
      if (config.key1?.trim() && config.key2?.trim()) {
        try {
          const info = await getUdropAccountInfo();
          if (info) {
            setAccountInfo(info);
            addToast(`uDrop account verified: ${info.email || info.username}`, "success");
            return;
          }
        } catch (e: any) {
          console.warn("uDrop API check failed or timed out:", e);
        }
      }
      // Test WebDAV connection via Rclone
      const { checkUdropFileExistsViaRclone } = await import("../lib/udrop");
      await checkUdropFileExistsViaRclone("__probe__", config.remoteName || "udrop");
      addToast(`uDrop WebDAV remote '${config.remoteName || "udrop"}:' verified active!`, "success");
    } catch (err: any) {
      addToast(`uDrop connection error: ${err?.message || err}`, "error");
    } finally {
      setTesting(false);
    }
  };

  const handleMountWebdav = async () => {
    if (!config.username?.trim() || !config.password?.trim()) {
      addToast("Please enter uDrop WebDAV username and password first", "error");
      return;
    }
    setMounting(true);
    try {
      saveUdropConfig(config);
      const res = await mountUdropWebdavRemote(rcloneConfigPath, config);
      if (res.success) {
        addToast(res.message, "success");
      } else {
        addToast(res.message, "error");
      }
    } catch (err: any) {
      addToast(`Failed to mount uDrop WebDAV: ${err?.message || err}`, "error");
    } finally {
      setMounting(false);
    }
  };

  const isConfigured = Boolean(
    (config.username?.trim() && config.password?.trim()) ||
    (rcloneConfigContent && /\[udrop\]/i.test(rcloneConfigContent))
  );

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-teal/15 border border-teal/30 flex items-center justify-center text-teal">
            <Globe size={18} />
          </div>
          <h2 className="font-display text-3xl text-bright tracking-wide">UDROP DIRECT STREAMING &amp; WEBDAV</h2>
        </div>
        <p className="text-subtle font-body text-sm mt-1">
          Configure uDrop cloud storage for 1-click direct link sharing and high-speed WebDAV rclone integration. Direct links support full HTTP 206 byte-range seeking for any media player or friend without needing account access.
        </p>
      </div>

      {/* Status Card */}
      <div className="bg-panel border border-border rounded-xl p-5">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${isConfigured ? "bg-emerald-400 animate-pulse" : "bg-neutral-600"}`} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">uDrop Engine Status</span>
              <span className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                isConfigured
                  ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30"
                  : "bg-neutral-800 text-neutral-400 border-neutral-700"
              }`}>
                {isConfigured ? "Configured & Ready" : "Setup Required"}
              </span>
            </div>
            <p className="text-xs text-subtle mt-0.5">
              {isConfigured
                ? `Ready for instant direct links and WebDAV file transfers via '${config.remoteName || "udrop"}:'`
                : "Enter your uDrop WebDAV credentials to enable WebDAV file transfers"}
            </p>
          </div>
        </div>
      </div>

      {/* Main Settings Card */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-border">
          <div>
            <span className="text-sm font-semibold text-white">Enable uDrop Integration</span>
            <p className="text-xs text-subtle mt-0.5">
              Enables uDrop in Share modal, direct link generation, and WebDAV transfer targets.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfig({ ...config, enabled: !config.enabled })}
            className={`w-11 h-6 rounded-full transition-colors relative ${
              config.enabled ? "bg-accent" : "bg-white/10"
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white absolute top-1 transition-transform ${
                config.enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <span className="text-xs font-medium text-subtle block mb-1.5">WebDAV Username / Email</span>
              <input
                type="text"
                value={config.username || ""}
                onChange={(e) => setConfig({ ...config, username: e.target.value })}
                placeholder="your.email@example.com"
                className="input-field text-xs font-mono w-full"
              />
            </div>
            <div>
              <span className="text-xs font-medium text-subtle block mb-1.5">WebDAV Password</span>
              <input
                type="password"
                value={config.password || ""}
                onChange={(e) => setConfig({ ...config, password: e.target.value })}
                placeholder="uDrop Account Password"
                className="input-field text-xs font-mono w-full"
              />
            </div>
          </div>

          <div className="pt-2 border-t border-border/50">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-subtle">API Key 1 &amp; Key 2</span>
              <a
                href="https://www.udrop.com"
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-accent hover:underline flex items-center gap-1"
              >
                <span>Find keys in uDrop account settings</span>
                <ExternalLink size={10} />
              </a>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <input
                  type="password"
                  value={config.key1 || ""}
                  onChange={(e) => setConfig({ ...config, key1: e.target.value })}
                  placeholder="API Key 1"
                  className="input-field text-xs font-mono w-full"
                />
              </div>
              <div>
                <input
                  type="password"
                  value={config.key2 || ""}
                  onChange={(e) => setConfig({ ...config, key2: e.target.value })}
                  placeholder="API Key 2"
                  className="input-field text-xs font-mono w-full"
                />
              </div>
            </div>
            <p className="text-[11px] text-subtle mt-1.5">
              API keys allow RcloneFlix to automatically query file short-URLs from uDrop to generate direct streaming URLs without local bandwidth.
            </p>
          </div>

          <div>
            <span className="text-xs font-medium text-subtle block mb-1.5">Rclone Remote Name</span>
            <input
              type="text"
              value={config.remoteName || "udrop"}
              onChange={(e) => setConfig({ ...config, remoteName: e.target.value })}
              placeholder="udrop"
              className="input-field text-xs font-mono w-full"
            />
            <p className="text-[11px] text-subtle mt-1">
              Rclone remote name created for WebDAV access. Defaults to <code className="text-accent">udrop</code>.
            </p>
          </div>

          {accountInfo && (
            <div className="p-3.5 rounded-lg bg-surface/50 border border-border/60 text-xs space-y-1.5">
              <div className="flex items-center justify-between text-bright font-medium">
                <span>Account: {accountInfo.username || accountInfo.email}</span>
                <span className="text-accent font-semibold">{accountInfo.status || "Active"}</span>
              </div>
              <p className="text-[11px] text-subtle">
                Account ID: {accountInfo.id} {accountInfo.level_id ? `· Level: ${accountInfo.level_id}` : ""}
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-border">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5"
            >
              {saved ? <Check size={14} /> : <Save size={14} />}
              <span>{saved ? "Saved" : "Save uDrop Settings"}</span>
            </button>

            <button
              type="button"
              onClick={handleMountWebdav}
              disabled={mounting || !config.username?.trim() || !config.password?.trim()}
              className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-teal border-teal/30 hover:border-teal disabled:opacity-50"
              title="Add or update the rclone WebDAV remote 'udrop:'"
            >
              {mounting ? (
                <Loader2 size={14} className="animate-spin text-teal" />
              ) : (
                <HardDrive size={14} />
              )}
              <span>{mounting ? "Mounting..." : "Mount uDrop Remote"}</span>
            </button>
          </div>

          <button
            type="button"
            onClick={handleTestAccount}
            disabled={testing || !config.key1?.trim() || !config.key2?.trim()}
            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 text-accent border-accent/30 hover:border-accent disabled:opacity-50"
            title="Verify API keys and check account storage"
          >
            {testing ? (
              <Loader2 size={14} className="animate-spin text-accent" />
            ) : (
              <RefreshCw size={14} />
            )}
            <span>{testing ? "Testing..." : "Test Account"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ExternalServersSettingsSection() {
  const addToast = useToastStore((s) => s.addToast);
  const [servers, setServers] = useState<ExternalMediaServerConfig[]>(() => loadExternalServers());
  const [plexTokenInput, setPlexTokenInput] = useState("");
  const [plexPin, setPlexPin] = useState<{ id: number; code: string; authUrl: string } | null>(null);
  const [pollingPin, setPollingPin] = useState(false);
  const [discoveringPlex, setDiscoveringPlex] = useState(false);

  const [jfUrl, setJfUrl] = useState("");
  const [jfUser, setJfUser] = useState("");
  const [jfPass, setJfPass] = useState("");
  const [jfLabel, setJfLabel] = useState("");
  const [connectingJf, setConnectingJf] = useState(false);
  const [syncingServerId, setSyncingServerId] = useState<string | null>(null);

  const handleStartPlexPin = async () => {
    try {
      const pin = await requestPlexPin();
      setPlexPin(pin);
      setPollingPin(true);
      window.open(pin.authUrl, "_blank", "noopener,noreferrer");
      let attempts = 0;
      const timer = setInterval(async () => {
        attempts++;
        if (attempts > 60) {
          clearInterval(timer);
          setPollingPin(false);
          return;
        }
        const token = await pollPlexPin(pin.id);
        if (token) {
          clearInterval(timer);
          setPollingPin(false);
          setPlexPin(null);
          setPlexTokenInput(token);
          await handleDiscoverPlex(token);
        }
      }, 2500);
    } catch (err: any) {
      addToast(`Plex PIN error: ${err?.message || err}`, "error");
      setPollingPin(false);
    }
  };

  const handleDiscoverPlex = async (tokenOverride?: string) => {
    const token = (tokenOverride ?? plexTokenInput).trim();
    if (!token) return;
    setDiscoveringPlex(true);
    try {
      const found = await discoverPlexServers(token);
      if (found.length === 0) {
        addToast("No Plex Media Servers found for this account", "info");
        return;
      }
      const existing = loadExternalServers();
      const merged = [...existing];
      for (const s of found) {
        const idx = merged.findIndex((x) => x.id === s.id);
        if (idx >= 0) merged[idx] = { ...merged[idx], ...s };
        else merged.push(s);
      }
      saveExternalServers(merged);
      setServers(merged);
      addToast(`Discovered ${found.length} Plex server(s) (Owned & Guest Passes)`, "success");
      for (const s of found) {
        await syncSingleServerContent(s);
      }
      setServers(loadExternalServers());
    } catch (err: any) {
      addToast(`Plex discovery failed: ${err?.message || err}`, "error");
    } finally {
      setDiscoveringPlex(false);
    }
  };

  const handleConnectJellyfin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jfUrl.trim() || !jfUser.trim()) return;
    setConnectingJf(true);
    try {
      const srv = await authenticateJellyfinServer(jfUrl, jfUser, jfPass, jfLabel.trim() || undefined);
      const next = [...loadExternalServers().filter((x) => x.id !== srv.id), srv];
      saveExternalServers(next);
      setServers(next);
      const count = await syncSingleServerContent(srv);
      setServers(loadExternalServers());
      setJfUrl("");
      setJfUser("");
      setJfPass("");
      setJfLabel("");
      addToast(`Connected "${srv.name}" and synced ${count} items!`, "success");
    } catch (err: any) {
      addToast(`Jellyfin connection failed: ${err?.message || err}`, "error");
    } finally {
      setConnectingJf(false);
    }
  };

  const handleSyncServer = async (srv: ExternalMediaServerConfig) => {
    setSyncingServerId(srv.id);
    try {
      const count = await syncSingleServerContent(srv);
      setServers(loadExternalServers());
      addToast(`Synced ${count} items from "${srv.name}" into Movies, TV & Music`, "success");
    } catch (err: any) {
      addToast(`Sync failed: ${err?.message || err}`, "error");
    } finally {
      setSyncingServerId(null);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-accent/15 border border-accent/30 flex items-center justify-center text-accent">
            <Server size={18} />
          </div>
          <h2 className="font-display text-3xl text-bright tracking-wide">
            PLEX &amp; JELLYFIN CLIENT HUB
          </h2>
        </div>
        <p className="text-subtle font-body text-sm mt-1">
          Connect your owned or friend-shared (Guest Pass) Plex and Jellyfin servers. Their Movies, TV Shows, and Music libraries load directly alongside your native Rclone and shared pass libraries.
        </p>
      </div>

      {/* Plex Discovery Card */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
              <Film size={16} className="text-amber-400" />
              <span>Plex Media Server (Owned &amp; Friend Guest Passes)</span>
            </h3>
            <p className="text-xs text-subtle mt-0.5">
              Sign in with Plex PIN or paste your X-Plex-Token to auto-discover all owned and shared servers.
            </p>
          </div>
          <button
            type="button"
            onClick={handleStartPlexPin}
            disabled={pollingPin}
            className="btn-accent text-xs py-2 px-3.5 flex items-center gap-1.5 shrink-0"
          >
            {pollingPin ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
            <span>{pollingPin ? "Waiting for Plex Auth…" : "Sign in with Plex PIN"}</span>
          </button>
        </div>

        {plexPin && (
          <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between">
            <div className="text-xs text-amber-200">
              <span>Authorize in your browser with code: </span>
              <strong className="font-mono text-base text-white tracking-widest ml-1">{plexPin.code}</strong>
            </div>
            <a
              href={plexPin.authUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-amber-300 underline"
            >
              Open Plex Auth Page
            </a>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <input
            type="password"
            value={plexTokenInput}
            onChange={(e) => setPlexTokenInput(e.target.value)}
            placeholder="Or paste X-Plex-Token manually..."
            className="input-field flex-1 text-xs font-mono"
          />
          <button
            type="button"
            disabled={discoveringPlex || !plexTokenInput.trim()}
            onClick={() => handleDiscoverPlex()}
            className="btn-secondary text-xs py-2 px-3.5 flex items-center gap-1.5 disabled:opacity-50"
          >
            {discoveringPlex ? <Loader2 size={13} className="animate-spin" /> : <Compass size={13} />}
            <span>Discover Servers</span>
          </button>
        </div>
      </div>

      {/* Jellyfin Auth Card */}
      <form onSubmit={handleConnectJellyfin} className="bg-panel border border-border rounded-xl p-5 space-y-4">
        <div>
          <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
            <Tv size={16} className="text-sky-400" />
            <span>Connect Jellyfin Media Server</span>
          </h3>
          <p className="text-xs text-subtle mt-0.5">
            Authenticate against any self-hosted or shared Jellyfin server.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-subtle mb-1">Server URL</label>
            <input
              type="text"
              value={jfUrl}
              onChange={(e) => setJfUrl(e.target.value)}
              placeholder="https://jellyfin.example.com"
              className="input-field w-full text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-subtle mb-1">Label (Optional)</label>
            <input
              type="text"
              value={jfLabel}
              onChange={(e) => setJfLabel(e.target.value)}
              placeholder="Home Jellyfin"
              className="input-field w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-subtle mb-1">Username</label>
            <input
              type="text"
              value={jfUser}
              onChange={(e) => setJfUser(e.target.value)}
              placeholder="Username"
              className="input-field w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-subtle mb-1">Password</label>
            <input
              type="password"
              value={jfPass}
              onChange={(e) => setJfPass(e.target.value)}
              placeholder="Password"
              className="input-field w-full text-xs"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={connectingJf || !jfUrl.trim() || !jfUser.trim()}
          className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5 disabled:opacity-50"
        >
          {connectingJf ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
          <span>Connect &amp; Sync Jellyfin</span>
        </button>
      </form>

      {/* Connected Servers List */}
      <div className="bg-panel border border-border rounded-xl p-5 space-y-3">
        <h3 className="font-heading font-semibold text-white text-sm">
          Connected External Servers ({servers.length})
        </h3>
        {servers.length === 0 ? (
          <p className="text-xs text-subtle py-4 text-center">
            No external Plex or Jellyfin servers connected yet.
          </p>
        ) : (
          <div className="space-y-2.5">
            {servers.map((s) => (
              <div
                key={s.id}
                className="p-3.5 rounded-xl bg-surface/60 border border-border flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white truncate">{s.name}</span>
                    <span
                      className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded border ${
                        s.type === "plex"
                          ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                          : "bg-sky-500/20 text-sky-300 border-sky-500/30"
                      }`}
                    >
                      {s.type}
                    </span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded border ${
                        s.isOwned
                          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                          : "bg-purple-500/15 text-purple-300 border-purple-500/30"
                      }`}
                    >
                      {s.isOwned ? "Owned" : `Guest Pass (${s.ownerName || "Shared"})`}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-subtle truncate mt-0.5">
                    {s.baseUrl} {typeof s.itemCount === "number" ? `· ${s.itemCount} items synced` : ""}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={syncingServerId === s.id}
                    onClick={() => handleSyncServer(s)}
                    className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1"
                  >
                    {syncingServerId === s.id ? (
                      <Loader2 size={12} className="animate-spin text-accent" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    <span>Sync</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      removeExternalServerAndPurge(s.id);
                      setServers(loadExternalServers());
                      addToast(`Removed "${s.name}"`, "info");
                    }}
                    className="p-1.5 rounded-lg text-subtle hover:text-red-400 hover:bg-white/5"
                    title="Remove server and purge synced items"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function UsenetIndexerSettingsCard() {
  const navigate = useNavigate();
  const addToast = useToastStore((s) => s.addToast);
  const rcloneConfigPath = useAppStore((s) => s.rcloneConfigPath);
  const isAndroid = typeof window !== "undefined" && (Boolean((window as any).AndroidBridge) || /android/i.test(navigator.userAgent));

  // OMGWTFNZBs credentials
  const [omgUser, setOmgUser] = useState(() => localStorage.getItem("rcloneflix_omg_user") || "");
  const [omgKey, setOmgKey] = useState(() => localStorage.getItem("rcloneflix_omg_key") || "");

  // InfiniDysk NNTP Provider state
  const [nntpHost, setNntpHost] = useState("");
  const [nntpPort, setNntpPort] = useState(563);
  const [nntpUser, setNntpUser] = useState("");
  const [nntpPass, setNntpPass] = useState("");
  const [nntpTls, setNntpTls] = useState(true);
  const [nntpConns, setNntpConns] = useState(10);
  const [nntpStatus, setNntpStatus] = useState<{
    configured: boolean;
    host: string;
    port: number;
    mounted_remote: string;
    port_8553_active: boolean;
    files_count: number;
  } | null>(null);

  // Search & Test state
  const [testQuery, setTestQuery] = useState("1080p");
  const [testing, setTesting] = useState(false);
  const [savingNntp, setSavingNntp] = useState(false);
  const [testingNntp, setTestingNntp] = useState(false);
  const [mountingNntp, setMountingNntp] = useState(false);
  const [usenetAutomount, setUsenetAutomount] = useState(
    () => typeof window !== "undefined" && localStorage.getItem("rcloneflix_usenet_automount") === "true"
  );
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [indexersHealth, setIndexersHealth] = useState<any[]>([]);
  const [playingNzbUrl, setPlayingNzbUrl] = useState<string | null>(null);

  const fetchNntpStatus = async () => {
    try {
      const st = await invoke<any>("usenet_get_status");
      setNntpStatus(st);
      if (st && st.host) {
        setNntpHost((prev) => prev || st.host);
        setNntpPort((prev) => (prev === 563 && st.port ? st.port : prev));
      }
    } catch {
      setNntpStatus(null);
    }
  };

  useEffect(() => {
    void fetchNntpStatus();
  }, []);

  const handleSaveIndexer = () => {
    localStorage.setItem("rcloneflix_omg_user", omgUser.trim());
    localStorage.setItem("rcloneflix_omg_key", omgKey.trim());
    addToast("Saved Usenet Indexer credentials", "success");
  };

  const handleSaveNntp = async () => {
    setSavingNntp(true);
    try {
      await invoke("usenet_save_config", {
        config: {
          host: nntpHost.trim(),
          port: Number(nntpPort) || 563,
          username: nntpUser.trim(),
          password: nntpPass.trim(),
          use_tls: nntpTls,
          connections_limit: Number(nntpConns) || 10,
        },
      });
      await fetchNntpStatus();
      addToast("Saved InfiniDysk NNTP Provider configuration", "success");
    } catch (err: any) {
      addToast(`Failed to save NNTP settings: ${err?.message || err}`, "error");
    } finally {
      setSavingNntp(false);
    }
  };

  const handleTestNntp = async () => {
    setTestingNntp(true);
    try {
      const msg = await invoke<string>("usenet_test_connection", {
        config: {
          host: nntpHost.trim(),
          port: Number(nntpPort) || 563,
          username: nntpUser.trim(),
          password: nntpPass.trim(),
          use_tls: nntpTls,
          connections_limit: Number(nntpConns) || 10,
        },
      });
      addToast(msg || "NNTP connection verified successfully!", "success");
    } catch (err: any) {
      addToast(`NNTP Connection failed: ${err?.message || err}`, "error");
    } finally {
      setTestingNntp(false);
    }
  };

  const handleMountRemote = async () => {
    setMountingNntp(true);
    try {
      const msg = await invoke<string>("usenet_mount_remote", {
        configPath: rcloneConfigPath || "",
      });
      await fetchNntpStatus();
      addToast(msg || "Mounted usenet-drive remote successfully", "success");
    } catch (err: any) {
      addToast(`Failed to mount usenet-drive: ${err?.message || err}`, "error");
    } finally {
      setMountingNntp(false);
    }
  };

  const handleTestSearch = async () => {
    setTesting(true);
    setSearchResults([]);
    setIndexersHealth([]);
    try {
      const res = await invoke<{ results: any[]; indexers: any[] }>("search_usenet_indexers", {
        query: testQuery.trim() || "1080p",
        omgUser: omgUser.trim() || null,
        omgApiKey: omgKey.trim() || null,
        enableNzbindex: true,
      });
      setSearchResults(res?.results ?? []);
      setIndexersHealth(res?.indexers ?? []);
      addToast(`Usenet Indexer returned ${res?.results?.length ?? 0} NZB releases`, "success");
    } catch (err: any) {
      addToast(`Indexer test failed: ${err?.message || err}`, "error");
    } finally {
      setTesting(false);
    }
  };

  const handlePlayNzb = async (nzbUrl: string) => {
    setPlayingNzbUrl(nzbUrl);
    try {
      const playables = await invoke<any[]>("parse_nzb_media_files", {
        nzbUrl,
        nzbXml: null,
        password: null,
        virtualDir: "Uncategorized",
      });
      if (playables && playables.length > 0) {
        const file = [...playables].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
        const davPath = (file.virtual_path || file.name).split("/").map(encodeURIComponent).join("/");
        const streamUrl = `http://127.0.0.1:8553/dav/${davPath}`;
        const now = Date.now();
        navigate("/play/video", {
          state: {
            item: {
              id: `usenet-${now}`,
              libraryId: "usenet",
              libraryType: "movies",
              title: file.name,
              filename: file.name,
              remotePath: streamUrl,
              streamUrl,
              sourceUrl: streamUrl,
              addedAt: now,
              lastScannedAt: now,
              isSourceBookmark: true,
            },
          },
        });
      } else {
        addToast("No playable media files found inside this NZB archive", "error");
      }
    } catch (err: any) {
      addToast(`Failed to parse/play NZB: ${err?.message || err}`, "error");
    } finally {
      setPlayingNzbUrl(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  return (
    <div className="bg-panel border border-border rounded-xl p-5 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h3 className="font-heading font-semibold text-white text-sm flex items-center gap-2">
            <Globe size={16} className="text-accent" />
            <span>Usenet Indexers &amp; InfiniDysk NNTP WebDAV Server</span>
          </h3>
          <p className="text-xs text-subtle mt-0.5">
            Connect standard Usenet (NNTP) news servers to stream virtual media mounts directly over embedded WebDAV (port 8553). Built-in RAR4/RAR5 unpacker handles stored multi-volume archives on the fly.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded border font-semibold ${
              nntpStatus?.port_8553_active
                ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                : "bg-amber-500/15 border-amber-500/30 text-amber-300"
            }`}
          >
            {nntpStatus?.port_8553_active ? "● Port 8553 Active" : "Port 8553 Idle"}
          </span>
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded border font-semibold ${
              nntpStatus?.configured
                ? "bg-blue-500/15 border-blue-500/30 text-blue-300"
                : "bg-white/10 border-white/20 text-subtle"
            }`}
          >
            {nntpStatus?.configured ? "NNTP Configured" : "NNTP Unconfigured"}
          </span>
        </div>
      </div>

      {/* Android Platform Guard */}
      {isAndroid ? (
        <div className="text-xs text-subtle bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
          InfiniDysk NNTP WebDAV virtual streaming and RAR volume parsing are available on Desktop versions only. TV Subscription discovery remains active on this device.
        </div>
      ) : (
        /* InfiniDysk NNTP Provider Form */
        <div className="border border-border/60 bg-black/20 rounded-lg p-4 space-y-3">
          <h4 className="text-xs font-semibold text-white flex items-center gap-2">
            <Server size={14} className="text-accent" />
            <span>InfiniDysk NNTP Server Configuration</span>
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-xs text-subtle mb-1">NNTP Host (e.g. news.eweka.nl, news.newshosting.com)</label>
              <input
                type="text"
                value={nntpHost}
                onChange={(e) => setNntpHost(e.target.value)}
                placeholder="news.provider.com"
                className="input-field w-full text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-subtle mb-1">NNTP Port (563 SSL / 119)</label>
              <input
                type="number"
                value={nntpPort}
                onChange={(e) => setNntpPort(Number(e.target.value))}
                placeholder="563"
                className="input-field w-full text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-subtle mb-1">Username</label>
              <input
                type="text"
                value={nntpUser}
                onChange={(e) => setNntpUser(e.target.value)}
                placeholder="Usenet username"
                className="input-field w-full text-xs font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-subtle mb-1">Password</label>
              <input
                type="password"
                value={nntpPass}
                onChange={(e) => setNntpPass(e.target.value)}
                placeholder="Usenet password"
                className="input-field w-full text-xs font-mono"
              />
            </div>
            <div className="flex items-center gap-4 pt-4">
              <label className="flex items-center gap-2 text-xs text-subtle cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={nntpTls}
                  onChange={(e) => setNntpTls(e.target.checked)}
                  className="rounded border-border text-accent focus:ring-0"
                />
                <span>Use TLS (SSL)</span>
              </label>
              <div className="flex items-center gap-1.5 text-xs text-subtle">
                <span>Conns:</span>
                <input
                  type="number"
                  value={nntpConns}
                  onChange={(e) => setNntpConns(Number(e.target.value))}
                  className="input-field w-14 text-xs font-mono py-1 px-1.5"
                  min={1}
                  max={50}
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button
              type="button"
              disabled={savingNntp}
              onClick={handleSaveNntp}
              className="btn-accent text-xs py-2 px-3.5 flex items-center gap-1.5"
            >
              {savingNntp ? <Loader2 size={13} className="animate-spin text-accent" /> : <Save size={13} />}
              <span>Save NNTP Server</span>
            </button>
            <button
              type="button"
              disabled={testingNntp || !nntpHost}
              onClick={handleTestNntp}
              className="btn-secondary text-xs py-2 px-3.5 flex items-center gap-1.5"
            >
              {testingNntp ? <Loader2 size={13} className="animate-spin text-accent" /> : <RefreshCw size={13} />}
              <span>Test Connection</span>
            </button>
            <button
              type="button"
              disabled={mountingNntp}
              onClick={handleMountRemote}
              className="btn-secondary text-xs py-2 px-3.5 flex items-center gap-1.5"
              title="Adds or updates 'usenet-drive' remote in rclone config pointing to http://127.0.0.1:8553/dav/"
            >
              {mountingNntp ? <Loader2 size={13} className="animate-spin text-accent" /> : <HardDrive size={13} />}
              <span>Mount Remote (usenet-drive)</span>
            </button>
            <label className="flex items-center gap-2 text-xs text-subtle cursor-pointer select-none ml-2">
              <input
                type="checkbox"
                checked={usenetAutomount}
                onChange={(e) => {
                  const next = e.target.checked;
                  setUsenetAutomount(next);
                  localStorage.setItem("rcloneflix_usenet_automount", next ? "true" : "false");
                }}
                className="rounded border-border text-accent focus:ring-0"
              />
              <span>Auto-mount usenet-drive via FUSE on startup (Linux)</span>
            </label>
          </div>
        </div>
      )}

      {/* Indexers Configuration */}
      <div className="border border-border/60 bg-black/20 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-white flex items-center gap-2">
            <Globe size={14} className="text-accent" />
            <span>Usenet Indexer Providers (OMGWTFNZBs &amp; NZBIndex.nl)</span>
          </h4>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold">
              NZBIndex.nl: Public Active
            </span>
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded border font-semibold ${
                omgUser && omgKey
                  ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                  : "bg-white/10 border-white/20 text-subtle"
              }`}
            >
              OMGWTFNZBs: {omgUser && omgKey ? "Configured" : "Optional"}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-subtle mb-1">OMGWTFNZBs Username (Optional)</label>
            <input
              type="text"
              value={omgUser}
              onChange={(e) => setOmgUser(e.target.value)}
              placeholder="OMGWTFNZBs username"
              className="input-field w-full text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-xs text-subtle mb-1">OMGWTFNZBs API Key (Optional)</label>
            <input
              type="password"
              value={omgKey}
              onChange={(e) => setOmgKey(e.target.value)}
              placeholder="API key"
              className="input-field w-full text-xs font-mono"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" onClick={handleSaveIndexer} className="btn-accent text-xs py-2 px-4 flex items-center gap-1.5">
            <Save size={14} />
            <span>Save Indexer Credentials</span>
          </button>
          <input
            type="text"
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder="Test query (e.g. 1080p)..."
            className="input-field text-xs font-mono w-48"
          />
          <button
            type="button"
            disabled={testing}
            onClick={handleTestSearch}
            className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
          >
            {testing ? <Loader2 size={13} className="animate-spin text-accent" /> : <RefreshCw size={13} />}
            <span>Search &amp; Test Indexers</span>
          </button>
        </div>

        {/* Indexers Diagnostic Health Badges */}
        {indexersHealth.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/40">
            <span className="text-[11px] text-subtle font-medium">Indexer Status:</span>
            {indexersHealth.map((idx, i) => (
              <span
                key={i}
                className={`text-[10px] font-mono px-2 py-0.5 rounded border font-semibold flex items-center gap-1 ${
                  idx.active
                    ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                    : "bg-red-500/15 border-red-500/30 text-red-300"
                }`}
              >
                {idx.active ? <CheckCircle2 size={10} /> : <AlertCircle size={10} />}
                <span>
                  {idx.name}: {idx.active ? `${idx.hits} hits` : `Error (${idx.error || "failed"})`}
                </span>
              </span>
            ))}
          </div>
        )}

        {/* Search Results with Play Action */}
        {searchResults.length > 0 && (
          <div className="pt-2 space-y-2">
            <h5 className="text-xs font-semibold text-white">NZB Search Results ({searchResults.length}):</h5>
            <div className="max-h-56 overflow-y-auto space-y-1.5 pr-1">
              {searchResults.map((r, i) => (
                <div
                  key={i}
                  className="bg-black/30 border border-border/50 rounded p-2 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-medium truncate" title={r.title}>
                      {r.title}
                    </p>
                    <div className="flex items-center gap-2 text-[10px] text-subtle mt-0.5 font-mono">
                      <span className="px-1.5 py-0.2 bg-white/10 rounded">{r.indexer}</span>
                      <span>{formatSize(r.size_bytes)}</span>
                      {r.published_at && <span>{r.published_at}</span>}
                    </div>
                  </div>
                  {!isAndroid && (
                    <button
                      type="button"
                      disabled={playingNzbUrl === r.nzb_url}
                      onClick={() => handlePlayNzb(r.nzb_url)}
                      className="btn-accent text-xs py-1 px-2.5 flex items-center gap-1 shrink-0"
                    >
                      {playingNzbUrl === r.nzb_url ? (
                        <Loader2 size={12} className="animate-spin text-accent" />
                      ) : (
                        <Play size={12} />
                      )}
                      <span>Play Stream</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
