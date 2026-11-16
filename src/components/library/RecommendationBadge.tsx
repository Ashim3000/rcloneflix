import { Sparkles, Flame, Zap, Award, Star } from "lucide-react";
import type { RecommendationBadgeEffect } from "../../store/appStore";

type Props = {
  text?: string;
  effect: RecommendationBadgeEffect;
  note?: string;
  className?: string;
};

export function RecommendationBadge({ text = "Recommended", effect, note, className = "" }: Props) {
  const getStyle = () => {
    switch (effect) {
      case "gold":
        return {
          icon: <Star size={10} className="fill-amber-300 text-amber-300" />,
          cls: "bg-gradient-to-r from-amber-950/90 to-yellow-950/90 text-amber-200 border-amber-400/80 shadow-[0_0_12px_rgba(251,191,36,0.45)]",
        };
      case "flame":
        return {
          icon: <Flame size={10} className="fill-orange-400 text-orange-200" />,
          cls: "bg-gradient-to-r from-amber-600 via-orange-600 to-rose-600 text-white border-amber-300/80 shadow-[0_0_12px_rgba(244,63,94,0.5)]",
        };
      case "glow":
        return {
          icon: <Zap size={10} className="fill-cyan-300 text-cyan-200" />,
          cls: "bg-cyan-950/90 text-cyan-200 border-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.55)]",
        };
      case "shimmer":
        return {
          icon: <Sparkles size={10} className="text-purple-200" />,
          cls: "bg-purple-950/90 text-purple-200 border-purple-400/80 animate-shimmer shadow-[0_0_10px_rgba(192,132,252,0.4)]",
        };
      case "pulse":
        return {
          icon: <Award size={10} className="text-accent" />,
          cls: "bg-accent/20 text-accent border-accent animate-pulse shadow-[0_0_8px_rgb(var(--color-accent-glow)/0.5)]",
        };
    }
  };

  const style = getStyle();

  return (
    <div
      className={`px-2 py-0.5 rounded-md border text-[10px] font-bold tracking-wider uppercase flex items-center gap-1 backdrop-blur-md transition-all ${style.cls} ${className}`}
      title={note || text}
    >
      {style.icon}
      <span>{text}</span>
    </div>
  );
}
