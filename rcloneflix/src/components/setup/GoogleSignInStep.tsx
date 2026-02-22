import { useState } from "react";
import { motion } from "framer-motion";
import { Chrome, CheckCircle2, SkipForward, ChevronRight, Cloud } from "lucide-react";
import { useAppStore } from "../../store/appStore";

type Props = {
  onNext: () => void;
  onBack: () => void;
};

export function GoogleSignInStep({ onNext, onBack }: Props) {
  const { googleLinked, setGoogleLinked } = useAppStore();
  const [isLoading, setIsLoading] = useState(false);

  // Placeholder — real OAuth will be wired in a later stage
  const handleGoogleSignIn = async () => {
    setIsLoading(true);
    setTimeout(() => {
      setGoogleLinked(true);
      setIsLoading(false);
    }, 1500);
  };

  const benefits = [
    "Sync your watch progress across devices",
    "Back up your library config to Google Drive",
    "Restore your setup on a new device instantly",
  ];

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
          SYNC &amp; SAVE
        </h2>
        <p className="text-subtle font-body text-sm leading-relaxed">
          Sign in with Google to save your play state and config. This is
          completely optional — RcloneFlix works great without it.
        </p>
      </div>

      {/* Benefits */}
      <div className="bg-panel border border-border rounded-xl p-5 mb-6 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Cloud size={16} className="text-accent" />
          <span className="text-text font-body font-semibold text-sm">
            With Google sync:
          </span>
        </div>
        {benefits.map((b) => (
          <div key={b} className="flex items-start gap-3 text-subtle text-sm font-body">
            <div className="w-1.5 h-1.5 rounded-full bg-accent mt-2 flex-shrink-0" />
            {b}
          </div>
        ))}
      </div>

      {!googleLinked ? (
        <motion.button
          onClick={handleGoogleSignIn}
          disabled={isLoading}
          className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-50 text-gray-800 font-body font-semibold px-6 py-3.5 rounded-xl transition-all duration-200 hover:shadow-lg active:scale-95 disabled:opacity-60 mb-4"
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.99 }}
        >
          {isLoading ? (
            <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
          ) : (
            <Chrome size={20} />
          )}
          {isLoading ? "Signing in..." : "Sign in with Google"}
        </motion.button>
      ) : (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex items-center gap-3 bg-teal/10 border border-teal/30 rounded-xl px-5 py-4 mb-4"
        >
          <CheckCircle2 size={22} className="text-teal flex-shrink-0" />
          <div>
            <p className="text-bright font-body font-semibold text-sm">
              Google account connected
            </p>
            <p className="text-subtle text-xs font-body mt-0.5">
              Your progress and config will sync automatically
            </p>
          </div>
        </motion.div>
      )}

      <div className="flex gap-3 justify-between">
        <button onClick={onBack} className="btn-ghost">
          Back
        </button>
        <div className="flex gap-2">
          {!googleLinked && (
            <button
              onClick={onNext}
              className="btn-ghost flex items-center gap-1.5"
            >
              <SkipForward size={15} />
              Skip for now
            </button>
          )}
          {googleLinked && (
            <motion.button
              onClick={onNext}
              className="btn-primary flex items-center gap-2"
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
            >
              Finish Setup
              <ChevronRight size={18} />
            </motion.button>
          )}
          {!googleLinked && null}
        </div>
      </div>
    </motion.div>
  );
}
