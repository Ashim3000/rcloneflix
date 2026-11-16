/**
 * Synthesizes a realistic vinyl needle-drop and dust crackle effect using the Web Audio API.
 * 100% offline, zero network requests, fully cross-platform (Linux WebKit, Chrome, Android, Windows).
 */

let audioCtx: AudioContext | null = null;
let activeSource: AudioNode | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx || audioCtx.state === "closed") {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    audioCtx = new AudioCtx();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Plays a warm vinyl needle-drop sound (~1.2s) followed by subtle surface crackle.
 */
export function playNeedleDropEffect(volume = 0.35): void {
  try {
    const ctx = getAudioContext();
    const duration = 1.2;
    const sampleRate = ctx.sampleRate;
    const frameCount = sampleRate * duration;

    // Create an audio buffer for needle mechanical thud + surface vinyl dust
    const buffer = ctx.createBuffer(2, frameCount, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    for (let i = 0; i < frameCount; i++) {
      const t = i / sampleRate;

      // Initial mechanical thud around 0.08s
      let thud = 0;
      if (t > 0.05 && t < 0.25) {
        const thudT = (t - 0.05) / 0.2;
        thud = Math.sin(thudT * Math.PI * 4) * Math.exp(-thudT * 8) * 0.8;
      }

      // Vinyl dust crackle clicks randomly distributed
      const isClick = Math.random() < 0.003;
      const click = isClick ? (Math.random() * 2 - 1) * 0.4 : 0;

      // Low surface friction noise
      const surfaceHiss = (Math.random() * 2 - 1) * 0.04;

      // Decay curve
      const decay = Math.exp(-t * 2.2);

      const val = (thud + click + surfaceHiss) * decay;
      left[i] = val;
      right[i] = val * 0.95 + (Math.random() * 2 - 1) * 0.01;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Filter to warm analog frequencies
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(3200, ctx.currentTime);

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(Math.min(1, Math.max(0, volume)), ctx.currentTime);

    source.connect(filter);
    filter.connect(gainNode);
    gainNode.connect(ctx.destination);

    source.start();
    activeSource = source;
  } catch (err) {
    console.warn("[audioEffects] Needle drop effect suppressed:", err);
  }
}

export function stopNeedleDropEffect(): void {
  try {
    if (activeSource) {
      (activeSource as any).stop?.();
      activeSource.disconnect();
      activeSource = null;
    }
  } catch {}
}
