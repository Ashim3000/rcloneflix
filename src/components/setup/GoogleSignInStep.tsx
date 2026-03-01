import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Chrome, Loader2, CheckCircle2, AlertCircle, CloudOff, ArrowRight } from "lucide-react";
import { useAppStore } from "../../store/appStore";
import { startGoogleSignIn, exchangeOAuthCode, restoreFromDrive, listenOAuthCallback } from "../../lib/sync";

type Props = {
  onNext: () => void;
  onSkip: () => void;
  isFirstStep?: boolean;
};

type State = "idle" | "waiting" | "exchanging" | "restoring" | "done" | "error";

export function GoogleSignInStep({ onNext, onSkip, isFirstStep }: Props) {
  const { setGoogleAccount, googleAccount } = useAppStore();
  const [state, setState] = useState<State>(googleAccount ? "done" : "idle");
  const [error, setError] = useState("");
  const [restoredConfig, setRestoredConfig] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listenOAuthCallback(async (code) => {
      setState("exchanging");
      try {
        const result = await exchangeOAuthCode(code);
        setGoogleAccount({
          email: result.email,
          displayName: result.displayName,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
        });

        if (isFirstStep) {
          setState("restoring");
          try {
            const backup = await restoreFromDrive();
            if (backup) setRestoredConfig(true);
          } catch {}
        }

        setState("done");
      } catch (e) {
        setError(String(e));
        setState("error");
      }
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  const handleSignIn = async () => {
    setError("");
    setState("waiting");
    try {
      await startGoogleSignIn();
    } catch (e) {
      setError(String(e));
      setState("error");
    }
  };

  return (
    <div className="flex flex-col items-center gap-6 max-w-md mx-auto text-center">
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        className="w-16 h-16 rounded-2xl bg-panel border border-border flex items-center justify-center"
      >
        <Chrome size={28} className="text-accent" />
      </motion.div>

      <div>
        <h2 className="font-display text-4xl text-bright tracking-wide mb-2">
          {isFirstStep ? "WELCOME BACK" : "GOOGLE SYNC"}
        </h2>
        <p className="text-subtle font-body text-sm leading-relaxed">
          {isFirstStep
            ? "Sign in with Google to restore your libraries, watch progress, and settings from a previous setup."
            : "Connect Google to back up your config and sync watch progress across devices."}
        </p>
      </div>

      {state === "done" && googleAccount ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full bg-panel border border-teal/30 rounded-xl p-4 flex items-center gap-3"
        >
          <CheckCircle2 size={20} className="text-teal flex-shrink-0" />
          <div className="text-left">
            <p className="text-text font-body text-sm font-medium">Signed in as {googleAccount.email}</p>
            {restoredConfig && (
              <p className="text-teal font-body text-xs mt-0.5">✓ Previous config restored from Drive</p>
            )}
            {!restoredConfig && isFirstStep && (
              <p className="text-subtle font-body text-xs mt-0.5">No previous backup found — starting fresh</p>
            )}
          </div>
        </motion.div>
      ) : (
        <div className="w-full space-y-3">
          {error && (
            <div className="flex items-center gap-2 text-danger text-xs font-body bg-danger/10 rounded-lg px-3 py-2">
              <AlertCircle size={13} />
              {error}
            </div>
          )}

          {state === "waiting" && (
            <div className="flex items-center gap-2 text-accent text-xs font-body bg-accent/10 rounded-lg px-3 py-2">
              <Loader2 size={13} className="animate-spin" />
              Browser opened — complete sign-in then return here
            </div>
          )}

          {(state === "exchanging" || state === "restoring") && (
            <div className="flex items-center gap-2 text-accent text-xs font-body">
              <Loader2 size={13} className="animate-spin" />
              {state === "exchanging" ? "Signing in..." : "Restoring config from Drive..."}
            </div>
          )}

          <button
            onClick={handleSignIn}
            disabled={state === "waiting" || state === "exchanging" || state === "restoring"}
            className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <Chrome size={16} />
            Sign in with Google
          </button>
        </div>
      )}

      <div className="flex gap-3 w-full">
        {state === "done" ? (
          <button onClick={onNext} className="btn-primary flex-1 flex items-center justify-center gap-2">
            {restoredConfig ? "Continue with restored config" : "Continue"}
            <ArrowRight size={16} />
          </button>
        ) : (
          <button
            onClick={onSkip}
            className="btn-secondary flex-1 flex items-center justify-center gap-2 text-subtle"
          >
            <CloudOff size={16} />
            {isFirstStep ? "Start fresh without signing in" : "Skip for now"}
          </button>
        )}
      </div>
    </div>
  );
}
