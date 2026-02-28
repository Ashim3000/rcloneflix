import { useState } from "react";
import { motion } from "framer-motion";
import { Eye, EyeOff, ExternalLink, ChevronRight, Info } from "lucide-react";
import { useAppStore } from "../../store/appStore";

type Props = {
  onNext: () => void;
  onBack: () => void;
};

function ApiKeyField({
  label,
  value,
  onChange,
  placeholder,
  helpUrl,
  helpText,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  helpUrl: string;
  helpText: string;
  required?: boolean;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="font-body font-medium text-text text-sm flex items-center gap-2">
          {label}
          {required ? (
            <span className="text-xs text-accent bg-accent/10 px-1.5 py-0.5 rounded font-body">
              Required for this library
            </span>
          ) : (
            <span className="text-xs text-subtle bg-panel px-1.5 py-0.5 rounded border border-border font-body">
              Optional
            </span>
          )}
        </label>
        <a
          href={helpUrl}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-accent hover:text-accent-glow text-xs font-body transition-colors"
        >
          Get free API key
          <ExternalLink size={11} />
        </a>
      </div>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input-field pr-12"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-subtle hover:text-text transition-colors"
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <p className="flex items-start gap-1.5 text-subtle text-xs font-body">
        <Info size={12} className="mt-0.5 flex-shrink-0" />
        {helpText}
      </p>
    </div>
  );
}

export function ApiKeysStep({ onNext, onBack }: Props) {
  const { tmdbApiKey, thePornDbApiKey, setTmdbApiKey, setThePornDbApiKey } =
    useAppStore();

  const canProceed = tmdbApiKey.trim().length > 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -24 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="max-w-xl mx-auto w-full"
    >
      <div className="mb-8">
        <h2 className="font-display text-4xl text-bright tracking-wide mb-2">
          API KEYS
        </h2>
        <p className="text-subtle font-body text-sm leading-relaxed">
          Some metadata providers need a free API key. These are stored
          encrypted on your device and never shared.
        </p>
      </div>

      <div className="space-y-6 mb-8">
        <ApiKeyField
          label="TMDB — Movies & TV Shows"
          value={tmdbApiKey}
          onChange={setTmdbApiKey}
          placeholder="eyJhbGciOiJIUzI1NiJ9..."
          helpUrl="https://www.themoviedb.org/settings/api"
          helpText="Used for movie and TV show posters, descriptions, ratings, and cast info. Free signup required."
          required
        />

        <div className="border-t border-border" />

        <ApiKeyField
          label="ThePornDB — Adult Video"
          value={thePornDbApiKey}
          onChange={setThePornDbApiKey}
          placeholder="your-theporndb-api-key"
          helpUrl="https://theporndb.net/register"
          helpText="Only needed if you want metadata for the Adult library. Skip this if you don't plan to use that library."
        />
      </div>

      {/* Info box */}
      <div className="bg-panel border border-border rounded-xl p-4 mb-8">
        <p className="text-subtle text-xs font-body leading-relaxed">
          <span className="text-teal font-semibold">No key needed:</span>{" "}
          MusicBrainz (music), Open Library (books), and Audnexus (audiobooks)
          are fully open APIs built into RcloneFlix — they just work.
        </p>
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
