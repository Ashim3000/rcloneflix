import React, { useState } from "react";
import { ListPlus } from "lucide-react";
import { type MediaItem } from "../../store/appStore";
import { AddToPlaylistModal } from "./AddToPlaylistModal";

interface AddToPlaylistButtonProps {
  items: MediaItem | MediaItem[];
  className?: string;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  label?: string;
}

export function AddToPlaylistButton({
  items,
  className = "",
  size = "md",
  showLabel = false,
  label = "Add to Playlist",
}: AddToPlaylistButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  const itemsArray = Array.isArray(items) ? items : [items];

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
    setIsOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        title={label}
        aria-label={label}
        className={`inline-flex items-center justify-center rounded-lg transition-all active:scale-95 text-white/70 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 ${sizeClasses} ${className}`}
      >
        <ListPlus size={iconSizes} />
        {showLabel && <span className="font-medium">{label}</span>}
      </button>

      <AddToPlaylistModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        items={itemsArray}
      />
    </>
  );
}
