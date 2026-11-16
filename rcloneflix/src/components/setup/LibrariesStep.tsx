import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Film,
  Tv,
  Music,
  Headphones,
  BookOpen,
  Eye,
  Plus,
  Trash2,
  ChevronRight,
  FolderOpen,
} from "lucide-react";
import { useAppStore, type Library } from "../../store/appStore";

type Props = {
  onNext: () => void;
  onBack: () => void;
};

const LIBRARY_TYPES = [
  { type: "movies" as const, label: "Movies", icon: Film, color: "text-blue-400" },
  { type: "tv" as const, label: "TV Shows", icon: Tv, color: "text-purple-400" },
  { type: "music" as const, label: "Music", icon: Music, color: "text-green-400" },
  { type: "audiobooks" as const, label: "Audiobooks", icon: Headphones, color: "text-yellow-400" },
  { type: "books" as const, label: "Books", icon: BookOpen, color: "text-orange-400" },
  { type: "adult" as const, label: "Adult", icon: Eye, color: "text-pink-400" },
];

function LibraryRow({
  lib,
  remotes,
  onRemove,
  onUpdate,
}: {
  lib: Library;
  remotes: { name: string; type: string }[];
  onRemove: () => void;
  onUpdate: (updates: Partial<Library>) => void;
}) {
  const meta = LIBRARY_TYPES.find((t) => t.type === lib.type)!;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
      className="bg-panel border border-border rounded-xl p-4 overflow-hidden"
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="w-8 h-8 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
          <meta.icon size={16} className={meta.color} />
        </div>
        <input
          type="text"
          value={lib.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="flex-1 bg-transparent text-bright font-body font-semibold text-sm outline-none border-b border-transparent focus:border-accent transition-colors"
        />
        <button
          onClick={onRemove}
          className="text-subtle hover:text-danger transition-colors p-1 rounded"
        >
          <Trash2 size={15} />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <FolderOpen size={14} className="text-subtle flex-shrink-0" />
        <select
          value={lib.remotePath.split("/")[0] + ":"}
          onChange={(e) => {
            const remote = e.target.value;
            const sub = lib.remotePath.includes("/")
              ? "/" + lib.remotePath.split("/").slice(1).join("/")
              : "";
            onUpdate({ remotePath: remote + sub });
          }}
          className="bg-surface border border-border rounded-lg px-3 py-1.5 text-text text-xs font-body outline-none focus:border-accent transition-colors"
        >
          <option value="">Select remote...</option>
          {remotes.map((r) => (
            <option key={r.name} value={r.name + ":"}>
              {r.name}: ({r.type})
            </option>
          ))}
        </select>
        <input
          type="text"
          value={
            lib.remotePath.includes("/")
              ? lib.remotePath.split("/").slice(1).join("/")
              : ""
          }
          onChange={(e) => {
            const remote = lib.remotePath.split(":")[0] + ":";
            onUpdate({
              remotePath: remote + (e.target.value ? "/" + e.target.value : ""),
            });
          }}
          placeholder="subfolder (optional)"
          className="flex-1 bg-surface border border-border rounded-lg px-3 py-1.5 text-text placeholder-subtle text-xs font-body outline-none focus:border-accent transition-colors"
        />
      </div>
    </motion.div>
  );
}

export function LibrariesStep({ onNext, onBack }: Props) {
  const { remotes, libraries, addLibrary, removeLibrary, updateLibrary } =
    useAppStore();
  const [showTypeMenu, setShowTypeMenu] = useState(false);

  const handleAdd = (type: Library["type"]) => {
    const meta = LIBRARY_TYPES.find((t) => t.type === type)!;
    addLibrary({
      id: crypto.randomUUID(),
      name: meta.label,
      type,
      remotePath: remotes[0] ? remotes[0].name + ":" : "",
    });
    setShowTypeMenu(false);
  };

  const canProceed = libraries.length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -24 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="max-w-xl mx-auto w-full"
    >
      <div className="mb-6">
        <h2 className="font-display text-4xl text-bright tracking-wide mb-2">
          SET UP LIBRARIES
        </h2>
        <p className="text-subtle font-body text-sm leading-relaxed">
          Map each library to a folder on your rclone remote. You can add more
          libraries later in Settings.
        </p>
      </div>

      <div className="space-y-3 mb-4 max-h-72 overflow-y-auto pr-1">
        <AnimatePresence>
          {libraries.map((lib) => (
            <LibraryRow
              key={lib.id}
              lib={lib}
              remotes={remotes}
              onRemove={() => removeLibrary(lib.id)}
              onUpdate={(u) => updateLibrary(lib.id, u)}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Add library button */}
      <div className="relative mb-8">
        <button
          onClick={() => setShowTypeMenu((s) => !s)}
          className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-border hover:border-accent text-subtle hover:text-accent rounded-xl py-3 text-sm font-body font-medium transition-all duration-200"
        >
          <Plus size={16} />
          Add Library
        </button>

        <AnimatePresence>
          {showTypeMenu && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.95 }}
              className="absolute top-full mt-2 left-0 right-0 bg-panel border border-border rounded-xl p-2 z-10 grid grid-cols-3 gap-1 shadow-card-hover"
            >
              {LIBRARY_TYPES.map((t) => (
                <button
                  key={t.type}
                  onClick={() => handleAdd(t.type)}
                  className="flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-surface text-subtle hover:text-text transition-colors font-body text-sm"
                >
                  <t.icon size={15} className={t.color} />
                  {t.label}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex gap-3 justify-between">
        <button onClick={onBack} className="btn-ghost">
          Back
        </button>
        <motion.button
          onClick={onNext}
          disabled={!canProceed}
          className="btn-primary flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none disabled:active:scale-100"
          whileHover={canProceed ? { scale: 1.02 } : {}}
          whileTap={canProceed ? { scale: 0.98 } : {}}
        >
          Continue
          <ChevronRight size={18} />
        </motion.button>
      </div>
    </motion.div>
  );
}
