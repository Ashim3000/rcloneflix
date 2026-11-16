/**
 * Shared Web Audio Graph management for real-time FFT spectrum visualization.
 * Ensures AudioContext and MediaElementAudioSourceNode are created exactly once per HTMLAudioElement.
 */

let sharedContext: AudioContext | null = null;
let sharedAnalyser: AnalyserNode | null = null;
let boundAudioElement: HTMLAudioElement | null = null;
let mediaElementSource: MediaElementAudioSourceNode | null = null;

export function getSharedAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    sharedContext = new AudioCtx();
  }
  if (sharedContext.state === "suspended") {
    sharedContext.resume().catch(() => {});
  }
  return sharedContext;
}

/**
 * Connects an HTMLAudioElement to the shared Web Audio graph with an AnalyserNode.
 * Returns the AnalyserNode instance. Safe to call multiple times with the same element.
 */
export function attachAudioElementToGraph(audioEl: HTMLAudioElement): AnalyserNode | null {
  try {
    const ctx = getSharedAudioContext();

    if (!sharedAnalyser) {
      sharedAnalyser = ctx.createAnalyser();
      sharedAnalyser.fftSize = 256;
      sharedAnalyser.smoothingTimeConstant = 0.8;
    }

    if (boundAudioElement === audioEl && mediaElementSource) {
      return sharedAnalyser;
    }

    // Connect element to graph
    boundAudioElement = audioEl;
    if (!mediaElementSource) {
      mediaElementSource = ctx.createMediaElementSource(audioEl);
      mediaElementSource.connect(sharedAnalyser);
      sharedAnalyser.connect(ctx.destination);
    }

    return sharedAnalyser;
  } catch (err) {
    console.warn("[audioGraph] Failed to bind HTMLAudioElement to Web Audio graph:", err);
    return sharedAnalyser;
  }
}

export function setSharedAnalyser(a: AnalyserNode | null) {
  sharedAnalyser = a;
}

export function getSharedAnalyser(): AnalyserNode | null {
  return sharedAnalyser;
}
