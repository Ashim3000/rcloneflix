import React, { useEffect, useRef } from "react";
import { getSharedAnalyser } from "../../lib/audioGraph";

interface SpectrumCanvasProps {
  className?: string;
  barColor?: string;
  barCount?: number;
  /** Drives the ambient fallback when no AnalyserNode is available (Linux desktop:
   *  WebAudio media-element taps are disabled there — see AudioMiniPlayer isLinuxDesktop). */
  isPlaying?: boolean;
}

export const SpectrumCanvas: React.FC<SpectrumCanvasProps> = ({
  className = "w-full h-24",
  barColor = "rgb(var(--color-accent, 99 102 241))",
  barCount = 48,
  isPlaying = true,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const playingRef = useRef(isPlaying);
  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Canvas 2D fillStyle cannot resolve CSS var() — assigning an invalid color string is
    // silently ignored, leaving the default #000 (invisible on the dark player). Resolve
    // the accent channels from the computed style instead, re-reading each frame so a
    // theme switch recolors the bars live.
    const resolveColor = (): string => {
      if (!barColor.includes("var(")) return barColor;
      try {
        const ch = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
        if (ch) return `rgb(${ch})`;
      } catch {
        // getComputedStyle can throw during teardown; fall through to the static fallback
      }
      return "rgb(232 160 32)";
    };

    // Handle high-DPI
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    if (prefersReducedMotion) {
      // Draw subtle static placeholder
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = resolveColor();
      ctx.globalAlpha = 0.3;
      const barWidth = rect.width / barCount;
      for (let i = 0; i < barCount; i++) {
        const height = (Math.sin(i * 0.3) * 0.3 + 0.4) * rect.height * 0.5;
        ctx.fillRect(i * barWidth + 1, rect.height - height, barWidth - 2, height);
      }
      return () => observer.disconnect();
    }

    const draw = () => {
      const analyser = getSharedAnalyser();
      const rect = canvas.getBoundingClientRect();
      const resolvedColor = resolveColor();
      ctx.clearRect(0, 0, rect.width, rect.height);

      if (analyser) {
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyser.getByteFrequencyData(dataArray);

        const barWidth = rect.width / barCount;
        const step = Math.floor(bufferLength / barCount);

        for (let i = 0; i < barCount; i++) {
          const value = dataArray[i * step] || 0;
          const percent = value / 255;
          const barHeight = Math.max(2, percent * rect.height * 0.9);

          const gradient = ctx.createLinearGradient(0, rect.height, 0, rect.height - barHeight);
          gradient.addColorStop(0, resolvedColor);
          gradient.addColorStop(1, "rgba(255, 255, 255, 0.8)");

          ctx.fillStyle = gradient;
          ctx.globalAlpha = 0.85;

          // Rounded bar tops
          const x = i * barWidth + 1;
          const y = rect.height - barHeight;
          const w = Math.max(1, barWidth - 2);
          const r = Math.min(w / 2, 2);

          ctx.beginPath();
          ctx.moveTo(x + r, y);
          ctx.lineTo(x + w - r, y);
          ctx.quadraticCurveTo(x + w, y, x + w, y + r);
          ctx.lineTo(x + w, rect.height);
          ctx.lineTo(x, rect.height);
          ctx.lineTo(x, y + r);
          ctx.quadraticCurveTo(x, y, x + r, y);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        // Ambient fallback: no AnalyserNode (Linux desktop — WebAudio taps would kill
        // the GStreamer sink). Deterministic procedural motion while playing, a quiet
        // baseline when paused. Never labeled "live".
        const barWidth = rect.width / barCount;
        ctx.fillStyle = resolvedColor;
        if (playingRef.current) {
          const t = performance.now() * 0.0012;
          for (let i = 0; i < barCount; i++) {
            const wave1 = Math.sin(t * 1.6 + i * 0.45);
            const wave2 = Math.cos(t * 2.3 - i * 0.35);
            const value = 0.15 + 0.45 * Math.abs(wave1 * 0.6 + wave2 * 0.4);
            const barHeight = Math.max(2, value * rect.height * 0.9);
            ctx.globalAlpha = 0.55;
            ctx.fillRect(i * barWidth + 1, rect.height - barHeight, Math.max(1, barWidth - 2), barHeight);
          }
        } else {
          ctx.globalAlpha = 0.25;
          for (let i = 0; i < barCount; i++) {
            ctx.fillRect(i * barWidth + 1, rect.height - 2, Math.max(1, barWidth - 2), 2);
          }
        }
        ctx.globalAlpha = 1;
      }

      animFrameRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
      observer.disconnect();
    };
  }, [barColor, barCount]);

  return <canvas ref={canvasRef} className={className} />;
};
