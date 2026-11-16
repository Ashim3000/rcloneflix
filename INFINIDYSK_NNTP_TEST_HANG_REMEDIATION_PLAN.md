# InfiniDysk NNTP Server Configuration Hang — Root Cause & Remediation Plan

> [!NOTE]
> This plan has been expanded and integrated into the comprehensive v1.0.3 plan:  
> **[`V1_0_3_COMPREHENSIVE_REMEDIATION_PLAN.md`](file:///home/ashim3000/rcloneflix/V1_0_3_COMPREHENSIVE_REMEDIATION_PLAN.md)** (covers NNTP test hangs, Streamtape Keep-Alive Bot Account-Wide API Auto-Discovery, and upcoming items).

**Target Reviewer:** Claude / Engineering Maintainer  
**Component:** `src-tauri/src/commands/usenet_dav.rs` & `src/pages/SettingsPage.tsx`  
**Symptom:** In *Settings &rarr; InfiniDysk*, clicking **"Test Connection"** hangs indefinitely ("never finishes the test") regardless of whether Easynews (`news.easynews.com:563`) or Premiumize (`usenet.premiumize.me:563` / `1563`) credentials are used.

---

## 1. Root Cause Breakdown

### A. Primary Root Cause: Rustls 0.23 Process-Level CryptoProvider Panic
In Rustls `0.23.37` (`tokio-rustls 0.26`), cryptography backends were decoupled into separate provider crates (`ring`, `aws-lc-rs`). 

In [`src-tauri/src/commands/usenet_dav.rs:140-150`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/usenet_dav.rs#L140-L150), `nntp_connect` creates a TLS client configuration using:
```rust
let tls_cfg = tokio_rustls::rustls::ClientConfig::builder()
    .with_root_certificates(roots)
    .with_no_client_auth();
```
Because no default crypto provider was registered process-wide and no provider was passed to the builder, Rustls triggers an **unhandled thread panic**:
```text
thread 'tokio-runtime-worker' panicked at rustls-0.23.37/src/crypto/mod.rs:249:14:
Could not automatically determine the process-level CryptoProvider from Rustls crate features.
Call CryptoProvider::install_default() before this point to select a provider manually, 
or make sure exactly one of the 'aws-lc-rs' and 'ring' features is enabled.
```

**Why it "never finishes":**
In Tauri v2, when an async command (`usenet_test_connection`) panics on a tokio thread without cleanly returning an `Err(String)`, the IPC response channel drops silently. The JavaScript Promise in `SettingsPage.tsx:6527` (`await invoke("usenet_test_connection", ...)`) never resolves or rejects. `testingNntp` remains `true` permanently, leaving the UI with an infinite spinner.

---

### B. Secondary Root Cause: Absence of Timeouts on Network Calls
Neither the TCP connection, the TLS handshake, nor the NNTP banner/authentication `read_line` calls have a `tokio::time::timeout(...)`.
If a port is firewalled, drops packets, or takes longer than expected, the command hangs indefinitely instead of failing gracefully with a helpful error message to the user.

---

### C. Tertiary Root Cause: Missing TLS Frame Flushes
In `nntp_connect` and `nntp_body`, text commands are written to the underlying stream via `r.get_mut().write_all(...)` without calling `r.get_mut().flush().await`.
In `tokio-rustls`, small writes (such as the 25-byte `AUTHINFO USER ...\r\n`) are buffered in the TLS record buffer. Without an explicit `.flush().await`, small packets are not guaranteed to be transmitted immediately over the socket, causing the client to wait for a reply to a command the server hasn't received.

---

## 2. Proposed Drop-in Remediation

### Fix 1: Ensure Crypto Provider is Installed & Add Timeouts in `nntp_connect`
In [`src-tauri/src/commands/usenet_dav.rs:131-172`](file:///home/ashim3000/rcloneflix/src-tauri/src/commands/usenet_dav.rs#L131-L172):

```rust
async fn nntp_connect(cfg: &UsenetServerConfig) -> Result<BufReader<Box<dyn NntpIo>>, String> {
    let host = cfg.host.trim().to_string();
    if host.is_empty() {
        return Err("Usenet host is not configured".to_string());
    }

    // 1. Ensure Rustls 0.23 default CryptoProvider is installed
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

    // 2. Connect with 10s TCP timeout
    let tcp = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        TcpStream::connect((host.as_str(), cfg.port))
    )
    .await
    .map_err(|_| format!("Connection to {}:{} timed out after 10s", host, cfg.port))?
    .map_err(|e| format!("NNTP connect error to {}:{}: {e}", host, cfg.port))?;

    let io: Box<dyn NntpIo> = if cfg.use_tls {
        let mut roots = tokio_rustls::rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        
        let tls_cfg = tokio_rustls::rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
            
        let connector = tokio_rustls::TlsConnector::from(Arc::new(tls_cfg));
        let name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|e| format!("Bad TLS host '{host}': {e}"))?;

        let tls_stream = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            connector.connect(name, tcp)
        )
        .await
        .map_err(|_| format!("TLS handshake with {host}:{} timed out after 10s", cfg.port))?
        .map_err(|e| format!("TLS handshake error with {host}:{}: {e}", cfg.port))?;

        Box::new(tls_stream)
    } else {
        Box::new(tcp)
    };

    let mut r = BufReader::new(io);
    let mut line = String::new();

    // 3. Read Banner with 8s timeout
    tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
        .await
        .map_err(|_| "Timed out waiting for NNTP greeting banner".to_string())?
        .map_err(|e| format!("Failed to read NNTP banner: {e}"))?;

    if !line.starts_with("200") && !line.starts_with("201") {
        return Err(format!("NNTP banner error: {}", line.trim()));
    }

    // 4. Authenticate with flushes and timeouts
    if !cfg.username.trim().is_empty() {
        // Send AUTHINFO USER
        r.get_mut().write_all(format!("AUTHINFO USER {}\r\n", cfg.username.trim()).as_bytes())
            .await.map_err(|e| e.to_string())?;
        r.get_mut().flush().await.map_err(|e| e.to_string())?;

        line.clear();
        tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
            .await
            .map_err(|_| "Timed out waiting for AUTHINFO USER response".to_string())?
            .map_err(|e| e.to_string())?;

        // 381 = Password required; 281 = Accepted without password
        if line.starts_with("381") {
            r.get_mut().write_all(format!("AUTHINFO PASS {}\r\n", cfg.password.trim()).as_bytes())
                .await.map_err(|e| e.to_string())?;
            r.get_mut().flush().await.map_err(|e| e.to_string())?;

            line.clear();
            tokio::time::timeout(std::time::Duration::from_secs(8), r.read_line(&mut line))
                .await
                .map_err(|_| "Timed out waiting for AUTHINFO PASS response".to_string())?
                .map_err(|e| e.to_string())?;
        }

        if !line.starts_with("281") {
            return Err(format!("NNTP authentication failed: {}", line.trim()));
        }
    }

    Ok(r)
}
```

### Fix 2: Flush in `nntp_body` & Add Safe Flush to `usenet_test_connection`
In `nntp_body`:
```rust
async fn nntp_body(r: &mut BufReader<Box<dyn NntpIo>>, message_id: &str) -> Result<(Vec<u8>, Option<u64>, Option<u64>), String> {
    let id = message_id.trim_matches(|c| c == '<' || c == '>');
    r.get_mut().write_all(format!("BODY <{id}>\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
    r.get_mut().flush().await.map_err(|e| e.to_string())?;
    ...
```

In `usenet_test_connection`:
```rust
#[tauri::command]
pub async fn usenet_test_connection(config: UsenetServerConfig) -> Result<String, String> {
    let test_fut = async {
        let mut conn = nntp_connect(&config).await?;
        let _ = conn.get_mut().write_all(b"QUIT\r\n").await;
        let _ = conn.get_mut().flush().await;
        Ok::<String, String>(format!("Connected and authenticated successfully! Host: {}", config.host))
    };

    tokio::time::timeout(std::time::Duration::from_secs(15), test_fut)
        .await
        .map_err(|_| format!("Connection test to {} timed out after 15 seconds.", config.host))?
}
```

---

## 3. Verification Plan
1. **Stand-alone probe check**: Verify both:
   - `news.easynews.com:563` (`svcmhllqjg` / `Qj05t0er`)
   - `usenet.premiumize.me:563` (`368052770` / `xmaihwcqmhfgufed`)
   connect, authenticate, and return `281 Authentication accepted` within < 1 second.
2. **Build check**: Run `cargo check --manifest-path src-tauri/Cargo.toml` to ensure clean compilation.
3. **Frontend verification**: Click "Test Connection" in the UI; verify that a success toast appears in ~1s and never hangs on failure.
