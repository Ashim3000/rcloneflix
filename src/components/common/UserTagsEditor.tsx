import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Tag, X } from "lucide-react";
import { useAppStore } from "../../store/appStore";

type Props = {
  itemIds: string[];
  tags: string[];
  libraryType: string;
  libraryRoute: string;
};

export function UserTagsEditor({ itemIds, tags, libraryType, libraryRoute }: Props) {
  const navigate = useNavigate();
  const listId = useId();
  const { mediaItems, setItemUserTags, bulkAddUserTag } = useAppStore();
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);

  const suggestions = useMemo(() => {
    const set = new Set<string>();
    for (const m of Object.values(mediaItems)) {
      if (m.libraryType === libraryType && m.userTags) {
        m.userTags.forEach((t) => set.add(t));
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [mediaItems, libraryType]);

  const handleAdd = () => {
    const clean = input.trim().replace(/^#/, "");
    if (!clean) return;
    if (itemIds.length === 1) {
      setItemUserTags(itemIds[0], [...tags, clean]);
    } else {
      bulkAddUserTag(itemIds, clean);
    }
    setInput("");
    setAdding(false);
  };

  const handleRemove = (tagToRemove: string) => {
    for (const id of itemIds) {
      const cur = mediaItems[id]?.userTags || [];
      setItemUserTags(
        id,
        cur.filter((t) => t !== tagToRemove)
      );
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono bg-accent/15 text-accent border border-accent/30"
        >
          <button
            type="button"
            onClick={() => navigate(`${libraryRoute}?tag=${encodeURIComponent(tag)}`)}
            className="hover:underline flex items-center gap-1 cursor-pointer"
            title={`Filter library by #${tag}`}
          >
            <Tag size={11} />#{tag}
          </button>
          <button
            type="button"
            onClick={() => handleRemove(tag)}
            className="text-accent/70 hover:text-bright ml-0.5 cursor-pointer"
            title={`Remove #${tag}`}
          >
            <X size={11} />
          </button>
        </span>
      ))}

      {adding ? (
        <div className="inline-flex items-center gap-1">
          <input
            type="text"
            list={listId}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="Tag name..."
            autoFocus
            className="bg-panel border border-accent/50 rounded-full px-2.5 py-0.5 text-xs text-bright focus:outline-none w-32"
          />
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={handleAdd}
            className="px-2 py-0.5 rounded-full bg-accent text-void text-xs font-semibold cursor-pointer"
          >
            Add
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono bg-panel border border-border text-subtle hover:text-bright hover:border-accent/40 transition-colors cursor-pointer"
        >
          <Plus size={11} /> Add Tag
        </button>
      )}
    </div>
  );
}
