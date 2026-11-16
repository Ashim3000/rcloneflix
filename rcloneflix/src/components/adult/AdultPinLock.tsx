import { useState, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, Delete, EyeOff } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { verifyPin } from "../../lib/pin";

type Props = {
  onUnlocked: () => void;
};

export function AdultPinLock({ onUnlocked }: Props) {
  const { adultSettings, setAdultUnlocked } = useAppStore();
  const [digits, setDigits] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const [shaking, setShaking] = useState(false);
  const length = adultSettings.pinLength;

  const handleDigit = async (d: string) => {
    if (digits.length >= length) return;
    const next = [...digits, d];
    setDigits(next);
    setError(false);

    if (next.length === length) {
      const pin = next.join("");
      const ok = await verifyPin(pin, adultSettings.pinHash);
      if (ok) {
        setAdultUnlocked(true);
        onUnlocked();
      } else {
        setShaking(true);
        setError(true);
        setTimeout(() => {
          setDigits([]);
          setShaking(false);
        }, 600);
      }
    }
  };

  const handleDelete = () => {
    setDigits((d) => d.slice(0, -1));
    setError(false);
  };

  const KEYS = ["1","2","3","4","5","6","7","8","9","","0","⌫"];

  return (
    <div className="fixed inset-0 bg-void/95 backdrop-blur-sm flex items-center justify-center z-50">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex flex-col items-center gap-8"
      >
        {/* Icon */}
        <div className="w-16 h-16 rounded-2xl bg-panel border border-border flex items-center justify-center">
          <Lock size={28} className="text-accent" />
        </div>

        <div className="text-center">
          <h2 className="font-display text-3xl text-bright tracking-wide mb-1">
            ADULT CONTENT
          </h2>
          <p className="text-subtle font-body text-sm">
            Enter your {length}-digit PIN to continue
          </p>
        </div>

        {/* PIN dots */}
        <motion.div
          animate={shaking ? { x: [0, -8, 8, -8, 8, 0] } : {}}
          transition={{ duration: 0.4 }}
          className="flex gap-4"
        >
          {Array.from({ length }).map((_, i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full border-2 transition-all duration-150 ${
                i < digits.length
                  ? error
                    ? "bg-danger border-danger"
                    : "bg-accent border-accent"
                  : "bg-transparent border-muted"
              }`}
            />
          ))}
        </motion.div>

        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-danger font-body text-sm -mt-4"
          >
            Incorrect PIN
          </motion.p>
        )}

        {/* Numpad */}
        <div className="grid grid-cols-3 gap-3">
          {KEYS.map((key, i) => {
            if (key === "") return <div key={i} />;
            if (key === "⌫") {
              return (
                <button
                  key={i}
                  onClick={handleDelete}
                  className="w-16 h-16 rounded-2xl bg-panel border border-border flex items-center justify-center text-subtle hover:text-text hover:border-subtle transition-all active:scale-95"
                >
                  <Delete size={20} />
                </button>
              );
            }
            return (
              <motion.button
                key={i}
                onClick={() => handleDigit(key)}
                whileTap={{ scale: 0.92 }}
                className="w-16 h-16 rounded-2xl bg-panel border border-border font-display text-2xl text-bright hover:bg-muted hover:border-subtle transition-all"
              >
                {key}
              </motion.button>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
