import QRCode from "qrcode";
import { invoke } from "@tauri-apps/api/core";

export const TV_PAIRING_PORT = 8080;

/**
 * Attempts to discover the device's local LAN IP (e.g. 192.168.x.x)
 * using AndroidBridge, Tauri commands, or WebRTC ICE candidate discovery.
 */
export async function getLocalLanIp(): Promise<string> {
  // 1. Android Bridge if running in Capacitor/Android shell
  if (typeof (window as any).AndroidBridge?.getLocalIp === "function") {
    try {
      const ip = (window as any).AndroidBridge.getLocalIp();
      if (ip && ip !== "127.0.0.1") return ip;
    } catch {}
  }

  // 2. Tauri native command if available
  if (typeof (window as any).__TAURI_INTERNALS__?.invoke === "function") {
    try {
      const ip = await invoke<string>("get_local_ip");
      if (ip && ip !== "127.0.0.1") return ip;
    } catch {}
  }

  // 3. WebRTC local IP candidate discovery
  return new Promise((resolve) => {
    try {
      const pc = new RTCPeerConnection({
        iceServers: [],
      });
      pc.createDataChannel("ip-detect");
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => resolve(window.location.hostname || "192.168.1.100"));

      const timer = setTimeout(() => {
        try { pc.close(); } catch {}
        resolve(window.location.hostname || "192.168.1.100");
      }, 1200);

      pc.onicecandidate = (e) => {
        if (!e?.candidate?.candidate) return;
        const candidate = e.candidate.candidate;
        const match = candidate.match(/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/);
        if (match && !match[1].startsWith("127.")) {
          clearTimeout(timer);
          try { pc.close(); } catch {}
          resolve(match[1]);
        }
      };
    } catch {
      resolve(window.location.hostname || "192.168.1.100");
    }
  });
}

/**
 * Generates an SVG string representation of a QR code for the given URL.
 */
export async function generateQrSvg(text: string): Promise<string> {
  try {
    return await QRCode.toString(text, {
      type: "svg",
      margin: 1,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
    });
  } catch (err) {
    console.error("Failed to generate QR code SVG:", err);
    return "";
  }
}

/**
 * Generates the standalone HTML page served to mobile/desktop phones
 * visiting http://<tv-ip>:8080 to upload passes or rclone.conf.
 */
export function getPairingPortalHtml(tvHost: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>RcloneFlix TV Setup</title>
  <style>
    :root {
      --bg: #090B0E;
      --card: #141822;
      --border: #232A3B;
      --accent: #E50914;
      --accent-hover: #F40612;
      --text: #F3F4F6;
      --subtle: #9CA3AF;
      --success: #10B981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px 16px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      width: 100%;
      max-width: 480px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    .header {
      text-align: center;
      margin-bottom: 8px;
    }
    .logo {
      font-size: 26px;
      font-weight: 800;
      letter-spacing: 1px;
      color: var(--accent);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .logo span { color: var(--text); }
    .subtitle {
      font-size: 14px;
      color: var(--subtle);
      margin-top: 6px;
    }
    .tv-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: var(--success);
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 9999px;
      margin-top: 8px;
      font-weight: 600;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dropzone {
      border: 2px dashed var(--border);
      border-radius: 12px;
      padding: 28px 16px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s ease;
      background: rgba(255, 255, 255, 0.02);
    }
    .dropzone:hover, .dropzone.dragover {
      border-color: var(--accent);
      background: rgba(229, 9, 20, 0.05);
    }
    .dropzone p {
      font-size: 14px;
      font-weight: 500;
      color: var(--text);
    }
    .dropzone span {
      font-size: 12px;
      color: var(--subtle);
      margin-top: 4px;
      display: block;
    }
    input[type="file"] { display: none; }
    textarea {
      width: 100%;
      height: 90px;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: #fff;
      padding: 12px;
      font-size: 13px;
      font-family: monospace;
      resize: none;
    }
    textarea:focus {
      outline: none;
      border-color: var(--accent);
    }
    .btn {
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 10px;
      padding: 14px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--accent-hover); }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .status {
      display: none;
      padding: 14px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 500;
      text-align: center;
    }
    .status.success {
      display: block;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid var(--success);
      color: var(--success);
    }
    .status.error {
      display: block;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid #ef4444;
      color: #f87171;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">RCLONE<span>FLIX</span></div>
      <p class="subtitle">Direct-to-TV Setup Portal</p>
      <div class="tv-badge">● Connected to Android TV (${tvHost})</div>
    </div>

    <div id="statusBox" class="status"></div>

    <div class="card">
      <div class="card-title">Option 1: Upload Pass or Config</div>
      <label class="dropzone" id="dropArea">
        <input type="file" id="fileInput" accept=".rflix,.conf,.config">
        <p>Tap to select .rflix or rclone.conf</p>
        <span>Supports Admin TV Pass, Guest Pass, or raw config</span>
      </label>
    </div>

    <div class="card">
      <div class="card-title">Option 2: Paste Pass Token Code</div>
      <textarea id="tokenInput" placeholder="Paste your base64 pass token code here..."></textarea>
      <button class="btn" id="sendTokenBtn" onclick="sendToken()">
        Send to TV
      </button>
    </div>
  </div>

  <script>
    const statusBox = document.getElementById('statusBox');
    const fileInput = document.getElementById('fileInput');
    const tokenInput = document.getElementById('tokenInput');
    const dropArea = document.getElementById('dropArea');

    function showStatus(msg, isSuccess) {
      statusBox.className = 'status ' + (isSuccess ? 'success' : 'error');
      statusBox.textContent = msg;
      statusBox.scrollIntoView({ behavior: 'smooth' });
    }

    async function submitPayload(type, payload, filename) {
      showStatus('Sending to TV...', true);
      try {
        const res = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, payload, filename })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showStatus('Successfully paired! Your TV is now loading the library.', true);
          tokenInput.value = '';
        } else {
          showStatus(data.error || 'Pairing failed. Please check the pass or config.', false);
        }
      } catch (err) {
        showStatus('Network error connecting to TV: ' + err.message, false);
      }
    }

    function sendToken() {
      const code = tokenInput.value.trim();
      if (!code) {
        showStatus('Please enter a pass token code.', false);
        return;
      }
      submitPayload('token', code, 'pass.rflix');
    }

    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const isRflix = file.name.endsWith('.rflix');
      const reader = new FileReader();
      if (isRflix) {
        reader.onload = () => {
          const bytes = new Uint8Array(reader.result);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          submitPayload('pass', base64, file.name);
        };
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = () => {
          submitPayload('config', reader.result, file.name);
        };
        reader.readAsText(file);
      }
    });

    ['dragenter', 'dragover'].forEach(name => {
      dropArea.addEventListener(name, (e) => { e.preventDefault(); dropArea.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(name => {
      dropArea.addEventListener(name, (e) => { e.preventDefault(); dropArea.classList.remove('dragover'); });
    });
    dropArea.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const file = dt.files[0];
      if (file) {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change'));
      }
    });
  </script>
</body>
</html>`;
}
