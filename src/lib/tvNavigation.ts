/**
 * Spatial Navigation and Controller / D-Pad Support for Android TV & Gamepads
 */

export function isTvEnvironment(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const bridge = (window as any).AndroidBridge;
    if (bridge && typeof bridge.isTv === "function") {
      return Boolean(bridge.isTv());
    }
  } catch {
    // ignore bridge errors
  }
  const ua = navigator.userAgent.toLowerCase();
  return (
    ua.includes("android tv") ||
    ua.includes("smart-tv") ||
    ua.includes("smarttv") ||
    ua.includes("googletv") ||
    ua.includes("crkey") ||
    /\baft[a-z0-9]+\b/.test(ua)
  );
}

function notifyNativeTextEditing(editing: boolean) {
  try {
    const bridge = (window as any).AndroidBridge;
    if (bridge && typeof bridge.setTextInputEditing === "function") {
      bridge.setTextInputEditing(editing);
    }
  } catch {
    // ignore
  }
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[tabindex="0"]:not([disabled])',
  '[role="button"]:not([disabled]):not([tabindex="-1"])',
  '.media-card',
  '.shelf-item',
].join(", ");

function isElementVisible(el: HTMLElement): boolean {
  if (el.dataset.tvSkip === "true" || el.tabIndex === -1) return false;
  if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) return false;

  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return false;

  // Walk up ancestor tree to catch parent containers with opacity-0 / display:none / data-tv-skip
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    if (cur.dataset.tvSkip === "true") return false;
    const style = window.getComputedStyle(cur);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity || "1") < 0.05
    ) {
      return false;
    }
    cur = cur.parentElement;
  }
  return true;
}

function getActiveModalRoot(): HTMLElement | null {
  const modals = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [aria-modal="true"], .fixed.inset-0.z-50, .fixed.inset-0.z-\\[60\\], .fixed.inset-0.z-\\[100\\]'
    )
  ).filter((el) => {
    if (el.offsetParent === null && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && parseFloat(style.opacity || "1") > 0.05;
  });
  return modals.length > 0 ? modals[modals.length - 1] : null;
}

function getFocusableElements(customScope?: ParentNode): HTMLElement[] {
  const scopeRoot: ParentNode = customScope || getActiveModalRoot() || document;
  const elements = Array.from(scopeRoot.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return elements.filter(isElementVisible);
}

function getCenter(rect: DOMRect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function focusElementSafely(el: HTMLElement) {
  // Keep text inputs readOnly during directional D-Pad focus so Android's soft keyboard
  // does not pop up until the user explicitly presses Enter/OK on the input.
  if (
    (el instanceof HTMLInputElement &&
      !["range", "checkbox", "radio", "button", "submit"].includes(el.type)) ||
    el instanceof HTMLTextAreaElement
  ) {
    if (el.dataset.tvEditing !== "true") {
      el.readOnly = true;
    }
  }
  el.focus({ preventScroll: true });
  const inShelf = el.closest('[data-tv-shelf="true"], .group\\/shelf');
  el.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
    inline: inShelf ? "center" : "nearest",
  });
}

function findInitialFocusTarget(): HTMLElement | null {
  const modalRoot = getActiveModalRoot();
  if (modalRoot) {
    const modalAuto = modalRoot.querySelector<HTMLElement>('[data-tv-autofocus="true"]');
    if (modalAuto && isElementVisible(modalAuto)) return modalAuto;
    const modalFocusables = getFocusableElements(modalRoot);
    const nonInputModal = modalFocusables.find(
      (el) => !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !el.hasAttribute("data-close-modal")
    );
    return nonInputModal || modalFocusables[0] || null;
  }

  const mainEl = document.querySelector("main");
  if (mainEl) {
    const autoEl = mainEl.querySelector<HTMLElement>('[data-tv-autofocus="true"]');
    if (autoEl && isElementVisible(autoEl)) return autoEl;

    const firstCard = mainEl.querySelector<HTMLElement>(".media-card, .shelf-item");
    if (firstCard && isElementVisible(firstCard)) return firstCard;

    const mainFocusables = getFocusableElements(mainEl).filter(
      (el) =>
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement) &&
        !el.closest("header")
    );
    if (mainFocusables.length > 0) return mainFocusables[0];
  }

  const all = getFocusableElements();
  return (
    all.find(
      (el) =>
        !(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement) &&
        !el.closest("header")
    ) ||
    all[0] ||
    null
  );
}

function scoreCandidates(
  current: HTMLElement,
  candidates: HTMLElement[],
  direction: "up" | "down" | "left" | "right"
): HTMLElement | null {
  const currentRect = current.getBoundingClientRect();
  const currentCenter = getCenter(currentRect);
  const currentShelf = current.closest('[data-tv-shelf="true"], .group\\/shelf');

  let bestCandidate: HTMLElement | null = null;
  let minScore = Infinity;

  for (const candidate of candidates) {
    if (candidate === current) continue;
    const candRect = candidate.getBoundingClientRect();
    const candCenter = getCenter(candRect);

    const dx = candCenter.x - currentCenter.x;
    const dy = candCenter.y - currentCenter.y;

    let isDirectionValid = false;
    let primaryDist = 0;
    let secondaryDist = 0;

    switch (direction) {
      case "up":
        isDirectionValid = dy < -6 && candRect.bottom <= currentCenter.y + 8;
        primaryDist = Math.abs(dy);
        secondaryDist = Math.abs(dx);
        break;
      case "down":
        isDirectionValid = dy > 6 && candRect.top >= currentCenter.y - 8;
        primaryDist = Math.abs(dy);
        secondaryDist = Math.abs(dx);
        break;
      case "left":
        isDirectionValid = dx < -6 && candRect.right <= currentCenter.x + 8;
        primaryDist = Math.abs(dx);
        secondaryDist = Math.abs(dy);
        break;
      case "right":
        isDirectionValid = dx > 6 && candRect.left >= currentCenter.x - 8;
        primaryDist = Math.abs(dx);
        secondaryDist = Math.abs(dy);
        break;
    }

    if (!isDirectionValid) continue;

    // Check vertical overlap for horizontal movement (same row/shelf bonus)
    const verticalOverlap =
      Math.min(currentRect.bottom, candRect.bottom) - Math.max(currentRect.top, candRect.top);
    const isSameRow = verticalOverlap > Math.min(currentRect.height, candRect.height) * 0.35;

    let score = primaryDist + secondaryDist * 2.2;

    if (direction === "left" || direction === "right") {
      const candShelf = candidate.closest('[data-tv-shelf="true"], .group\\/shelf');
      if (currentShelf && candShelf === currentShelf) {
        score *= 0.25; // Strongly keep Left/Right inside the same horizontal shelf
      } else if (isSameRow) {
        score *= 0.45;
      } else {
        score += 1200 + secondaryDist * 6; // Heavy penalty for jumping rows on Left/Right
      }
    } else {
      // Up / Down: penalize inputs in headers unless nothing else is available
      if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
        score += 350;
      }
    }

    if (score < minScore) {
      minScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

/**
 * Zone-aware nearest element resolver (Sidebar <aside> vs Main <main> vs Modal)
 */
function findNearestElement(
  current: HTMLElement,
  direction: "up" | "down" | "left" | "right",
  lastMainFocused: HTMLElement | null
): HTMLElement | null {
  const modalRoot = getActiveModalRoot();
  if (modalRoot) {
    const modalCandidates = getFocusableElements(modalRoot);
    return scoreCandidates(current, modalCandidates, direction);
  }

  const asideEl = document.querySelector("aside");
  const mainEl = document.querySelector("main");
  const inAside = Boolean(asideEl && asideEl.contains(current));
  const inMain = Boolean(mainEl && mainEl.contains(current));

  if (inAside && asideEl) {
    if (direction === "up" || direction === "down") {
      return scoreCandidates(current, getFocusableElements(asideEl), direction);
    }
    if (direction === "left") {
      return null; // Already in leftmost sidebar rail
    }
    if (direction === "right" && mainEl) {
      if (lastMainFocused && mainEl.contains(lastMainFocused) && isElementVisible(lastMainFocused)) {
        return lastMainFocused;
      }
      return findInitialFocusTarget();
    }
  }

  if (inMain && mainEl) {
    const mainCandidates = getFocusableElements(mainEl);
    if (direction === "up" || direction === "down" || direction === "right") {
      return scoreCandidates(current, mainCandidates, direction);
    }
    if (direction === "left") {
      // First look for an element to the left in the same row inside <main>
      const currentRect = current.getBoundingClientRect();
      const sameRowMainCandidates = mainCandidates.filter((cand) => {
        if (cand === current) return false;
        const r = cand.getBoundingClientRect();
        const overlap = Math.min(currentRect.bottom, r.bottom) - Math.max(currentRect.top, r.top);
        return overlap > Math.min(currentRect.height, r.height) * 0.3;
      });
      const leftInRow = scoreCandidates(current, sameRowMainCandidates, "left");
      if (leftInRow) return leftInRow;

      // Otherwise transition smoothly into the Sidebar <aside>
      if (asideEl) {
        const activeNav = asideEl.querySelector<HTMLElement>("a.border-accent, a.text-accent");
        if (activeNav && isElementVisible(activeNav)) return activeNav;
        const asideCandidates = getFocusableElements(asideEl);
        if (asideCandidates.length > 0) return asideCandidates[0];
      }
    }
  }

  return scoreCandidates(current, getFocusableElements(), direction);
}

/**
 * Initializes spatial navigation listeners for Android TV remotes and gamepads.
 */
export function initTvNavigation(): () => void {
  let lastMainFocused: HTMLElement | null = null;

  if (typeof window !== "undefined") {
    (window as any).__rcloneflix_handle_back = (): boolean => {
      const activeEl = document.activeElement as HTMLElement | null;
      if (
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement
      ) {
        activeEl.dataset.tvEditing = "false";
        activeEl.readOnly = true;
        notifyNativeTextEditing(false);
        activeEl.blur();
        const fallback = findInitialFocusTarget();
        if (fallback) focusElementSafely(fallback);
        return true;
      }

      if (window.location.pathname.startsWith("/play/")) {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
        return true;
      }

      const modalRoot = getActiveModalRoot();
      if (modalRoot) {
        const closeBtn =
          modalRoot.querySelector<HTMLElement>(
            'button[aria-label*="Close" i], button[title*="Close" i], button[data-close-modal="true"]'
          ) ||
          Array.from(modalRoot.querySelectorAll<HTMLElement>("button")).find((btn) => {
            const txt = (btn.textContent || "").trim().toLowerCase();
            return txt === "cancel" || txt === "close" || btn.querySelector("svg.lucide-x") !== null;
          });
        if (closeBtn) {
          closeBtn.click();
          return true;
        }
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
        );
        return true;
      }

      const path = window.location.pathname;
      if (path !== "/home" && path !== "/" && path !== "/setup") {
        window.history.back();
        return true;
      }

      return false;
    };
  }

  if (!isTvEnvironment()) {
    document.body.classList.remove("is-android-tv");
    return () => {};
  }

  document.body.classList.add("is-android-tv");
  let active = true;

  const handleFocusIn = (e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const mainEl = document.querySelector("main");
    if (
      mainEl &&
      mainEl.contains(target) &&
      !(target instanceof HTMLInputElement) &&
      !(target instanceof HTMLTextAreaElement)
    ) {
      lastMainFocused = target;
    }
  };

  const handleFocusOut = (e: FocusEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      target.dataset.tvEditing = "false";
      target.readOnly = true;
      notifyNativeTextEditing(false);
    }
  };

  const handleMediaControl = (e: Event) => {
    if (window.location.pathname.startsWith("/play/")) return;
    const detail = (e as CustomEvent).detail;
    if (!detail) return;
    if (detail.action === "toggle" || detail.action === "play") {
      const current = document.activeElement as HTMLElement | null;
      if (current && current.classList.contains("media-card")) {
        const playTrigger = current.querySelector<HTMLElement>('[data-tv-play="true"]');
        if (playTrigger) {
          playTrigger.click();
          return;
        }
        current.click();
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // Let dedicated media players handle their own keyboard/remote events
    if (window.location.pathname.startsWith("/play/")) {
      return;
    }

    const activeEl = document.activeElement as HTMLElement | null;
    const isInputFocused =
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement;
    const isInputEditing = isInputFocused && activeEl?.dataset.tvEditing === "true";

    // Handle back button on Android TV remote
    if (e.key === "Escape" || e.key === "Backspace" || e.key === "GoBack") {
      if (isInputFocused) {
        if (e.key === "Backspace" && isInputEditing) return;
        e.preventDefault();
        activeEl.dataset.tvEditing = "false";
        activeEl.readOnly = true;
        notifyNativeTextEditing(false);
        activeEl.blur();
        const fallback = findInitialFocusTarget();
        if (fallback) focusElementSafely(fallback);
        return;
      }
      const modalRoot = getActiveModalRoot();
      if (modalRoot) {
        const closeBtn =
          modalRoot.querySelector<HTMLElement>(
            'button[aria-label*="Close" i], button[title*="Close" i], button[data-close-modal="true"]'
          ) ||
          Array.from(modalRoot.querySelectorAll<HTMLElement>("button")).find(
            (btn) => btn.querySelector("svg.lucide-x") !== null
          );
        if (closeBtn) {
          e.preventDefault();
          closeBtn.click();
          return;
        }
      }
      if (
        window.location.pathname !== "/home" &&
        window.location.pathname !== "/" &&
        window.location.pathname !== "/setup"
      ) {
        e.preventDefault();
        window.history.back();
        return;
      }
    }

    let direction: "up" | "down" | "left" | "right" | null = null;
    if (e.key === "ArrowUp") direction = "up";
    else if (e.key === "ArrowDown") direction = "down";
    else if (e.key === "ArrowLeft") direction = "left";
    else if (e.key === "ArrowRight") direction = "right";

    if (!direction) {
      if (e.key === "Enter") {
        if (!activeEl || activeEl === document.body || !isElementVisible(activeEl)) {
          const initial = findInitialFocusTarget();
          if (initial) {
            e.preventDefault();
            focusElementSafely(initial);
          }
          return;
        }

        // If focused on a text input, Enter unlocks editing & opens the soft keyboard
        if (
          (activeEl instanceof HTMLInputElement &&
            !["range", "checkbox", "radio", "button", "submit"].includes(activeEl.type)) ||
          activeEl instanceof HTMLTextAreaElement
        ) {
          e.preventDefault();
          if (activeEl.dataset.tvEditing !== "true") {
            activeEl.dataset.tvEditing = "true";
            activeEl.readOnly = false;
            notifyNativeTextEditing(true);
            activeEl.focus();
            activeEl.click();
          } else {
            // Second Enter submits the form if inside one, or exits editing
            const form = activeEl.closest("form");
            if (form) {
              form.requestSubmit();
            }
            activeEl.dataset.tvEditing = "false";
            activeEl.readOnly = true;
            notifyNativeTextEditing(false);
          }
          return;
        }

        if (activeEl instanceof HTMLElement) {
          if (
            !e.isTrusted ||
            !["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(activeEl.tagName)
          ) {
            e.preventDefault();
            activeEl.click();
          }
        }
      }
      return;
    }

    // Allow Left/Right cursor movement inside an actively edited text field
    if (isInputEditing && (direction === "left" || direction === "right")) {
      return;
    }

    // Allow Left/Right scrubbing on range sliders
    if (
      activeEl instanceof HTMLInputElement &&
      activeEl.type === "range" &&
      (direction === "left" || direction === "right")
    ) {
      return;
    }

    const focusables = getFocusableElements();
    if (!activeEl || activeEl === document.body || !focusables.includes(activeEl)) {
      const target = findInitialFocusTarget();
      if (target) {
        e.preventDefault();
        focusElementSafely(target);
      }
      return;
    }

    const next = findNearestElement(activeEl, direction, lastMainFocused);
    if (next) {
      e.preventDefault();
      if (isInputEditing && activeEl) {
        activeEl.dataset.tvEditing = "false";
        activeEl.readOnly = true;
        notifyNativeTextEditing(false);
      }
      focusElementSafely(next);
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  window.addEventListener("focusin", handleFocusIn);
  window.addEventListener("focusout", handleFocusOut);
  window.addEventListener("rcloneflix:media-control", handleMediaControl);

  // Auto-focus observer when route changes or modals mount and focus is lost to <body>
  let autoFocusTimer: ReturnType<typeof setTimeout> | null = null;
  const observer = new MutationObserver(() => {
    if (window.location.pathname.startsWith("/play/")) return;
    const activeEl = document.activeElement as HTMLElement | null;
    const modalRoot = getActiveModalRoot();
    const needsFocus =
      !activeEl ||
      activeEl === document.body ||
      !isElementVisible(activeEl) ||
      (modalRoot && !modalRoot.contains(activeEl));

    if (needsFocus) {
      if (autoFocusTimer) clearTimeout(autoFocusTimer);
      autoFocusTimer = setTimeout(() => {
        if (window.location.pathname.startsWith("/play/")) return;
        const curr = document.activeElement as HTMLElement | null;
        const activeModal = getActiveModalRoot();
        if (
          !curr ||
          curr === document.body ||
          !isElementVisible(curr) ||
          (activeModal && !activeModal.contains(curr))
        ) {
          const target = findInitialFocusTarget();
          if (target) focusElementSafely(target);
        }
      }, 120);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Gamepad polling loop (only on TV)
  let lastGamepadButtonPress = 0;
  const pollGamepads = () => {
    if (!active) return;
    try {
      const raw = navigator.getGamepads ? navigator.getGamepads() : null;
      if (raw) {
        const now = Date.now();
        const len = raw.length || 0;
        for (let i = 0; i < len; i++) {
          const gp = raw[i];
          if (!gp || !gp.buttons) continue;
          if (now - lastGamepadButtonPress < 180) continue;

          if (gp.buttons[12]?.pressed) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
            lastGamepadButtonPress = now;
          } else if (gp.buttons[13]?.pressed) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
            lastGamepadButtonPress = now;
          } else if (gp.buttons[14]?.pressed) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
            lastGamepadButtonPress = now;
          } else if (gp.buttons[15]?.pressed) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
            lastGamepadButtonPress = now;
          } else if (gp.buttons[0]?.pressed) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
            lastGamepadButtonPress = now;
          } else if (gp.buttons[1]?.pressed) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            lastGamepadButtonPress = now;
          }
        }
      }
    } catch {
      // ignore gamepad errors
    }

    if (active) {
      requestAnimationFrame(pollGamepads);
    }
  };

  requestAnimationFrame(pollGamepads);

  return () => {
    active = false;
    if (autoFocusTimer) clearTimeout(autoFocusTimer);
    observer.disconnect();
    document.body.classList.remove("is-android-tv");
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("focusin", handleFocusIn);
    window.removeEventListener("focusout", handleFocusOut);
    window.removeEventListener("rcloneflix:media-control", handleMediaControl);
  };
}
