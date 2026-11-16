import React from "react";
import { Heart } from "lucide-react";
import { useAppStore, isItemFavorited } from "../../store/appStore";

interface FavoriteButtonProps {
  itemId: string;
  className?: string;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  label?: string;
}

export function FavoriteButton({
  itemId,
  className = "",
  size = "md",
  showLabel = false,
  label = "Favorite",
}: FavoriteButtonProps) {
  const isFavorite = useAppStore((s) => {
    const item = s.mediaItems[itemId];
    if (item) return isItemFavorited(item, s.favorites, s.mediaItems);
    return Boolean(s.favorites[itemId]);
  });
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);

  const sizeClasses = {
    sm: "p-1.5 text-xs gap-1",
    md: "p-2 text-sm gap-1.5",
    lg: "px-4 py-2.5 text-sm gap-2",
  }[size];

  const iconSizes = {
    sm: 14,
    md: 18,
    lg: 20,
  }[size];

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    toggleFavorite(itemId);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      title={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
      aria-label={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
      className={`inline-flex items-center justify-center rounded-lg transition-all active:scale-90 ${
        isFavorite
          ? "text-rose-500 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30"
          : "text-white/70 hover:text-rose-400 bg-white/5 hover:bg-white/10 border border-white/10"
      } ${sizeClasses} ${className}`}
    >
      <Heart
        size={iconSizes}
        className={`transition-transform duration-200 ${
          isFavorite ? "fill-rose-500 scale-105" : "hover:scale-110"
        }`}
      />
      {showLabel && (
        <span className="font-medium">
          {isFavorite ? "Favorited" : label}
        </span>
      )}
    </button>
  );
}
