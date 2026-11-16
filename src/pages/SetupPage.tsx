import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { KeyRound, FolderDown } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { RestoreStep } from "../components/setup/RestoreStep";
import { WelcomeStep } from "../components/setup/WelcomeStep";
import { RcloneConfigStep } from "../components/setup/RcloneConfigStep";
import { ApiKeysStep } from "../components/setup/ApiKeysStep";
import { LibrariesStep } from "../components/setup/LibrariesStep";
import { SetupSteps } from "../components/setup/SetupSteps";
import { ImportAccessPassModal } from "../components/accessPass/ImportAccessPassModal";
import { isTvEnvironment } from "../lib/tvNavigation";

// rclone config comes first now: it is the transport for restoring a backup,
// so there is nothing useful to do before it is loaded.
const STEPS = [
  { number: 1, id: "rclone",    label: "Rclone" },
  { number: 2, id: "restore",   label: "Restore" },
  { number: 3, id: "apikeys",   label: "API Keys" },
  { number: 4, id: "libraries", label: "Libraries" },
] as const;

type StepId = typeof STEPS[number]["id"];

export function SetupPage() {
  const [stepId, setStepId] = useState<StepId>("rclone");
  const [isPassModalOpen, setIsPassModalOpen] = useState(false);
  const { completeSetup } = useAppStore();
  const navigate = useNavigate();

  const currentStep = STEPS.find((s) => s.id === stepId)!;

  const next = () => {
    const idx = STEPS.findIndex((s) => s.id === stepId);
    const nextStep = STEPS[idx + 1];
    if (nextStep) setStepId(nextStep.id);
    else finish();
  };

  const prev = () => {
    const idx = STEPS.findIndex((s) => s.id === stepId);
    const prevStep = STEPS[idx - 1];
    if (prevStep) setStepId(prevStep.id);
  };

  const finish = () => {
    completeSetup();
    navigate("/home");
  };

  return (
    <div className="h-screen max-h-screen overflow-y-auto bg-void flex flex-col items-center px-6">
      <div className="w-full max-w-2xl my-auto py-10">
        {/* Guest Pass Quick Banner */}
        <div className="mb-8 p-4 rounded-xl bg-gradient-to-r from-accent/15 via-panel to-panel border border-accent/30 flex items-center justify-between gap-4 shadow-lg">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center text-accent flex-shrink-0">
              <KeyRound size={20} />
            </div>
            <div>
              <p className="text-bright font-display text-sm tracking-wide">
                HAVE AN ACCESS PASS FROM A FRIEND?
              </p>
              <p className="text-subtle font-body text-xs mt-0.5">
                Import your <span className="text-accent font-mono">.rflix</span> pass to start streaming shared libraries instantly with zero technical setup.
              </p>
            </div>
          </div>
          <button
            type="button"
            data-tv-autofocus={isTvEnvironment() ? "true" : undefined}
            onClick={() => setIsPassModalOpen(true)}
            className="btn-primary py-2 px-4 text-xs font-semibold whitespace-nowrap shadow-accent-glow flex items-center gap-2 flex-shrink-0 focus:ring-4 focus:ring-accent focus:outline-none"
          >
            <FolderDown size={15} />
            Import Pass
          </button>
        </div>

        {/* Progress indicator */}
        <div className="flex justify-center mb-10">
          <SetupSteps
            steps={STEPS.map((s) => ({ number: s.number, label: s.label }))}
            currentStep={currentStep.number}
          />
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={stepId}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.25 }}
          >
            {stepId === "rclone" && (
              <RcloneConfigStep onNext={next} onBack={prev} />
            )}
            {stepId === "restore" && (
              <RestoreStep onNext={next} onBack={prev} />
            )}
            {stepId === "apikeys" && (
              <ApiKeysStep onNext={next} onBack={prev} />
            )}
            {stepId === "libraries" && (
              <LibrariesStep onNext={finish} onBack={prev} />
            )}
          </motion.div>
        </AnimatePresence>

        <ImportAccessPassModal
          isOpen={isPassModalOpen}
          onClose={() => setIsPassModalOpen(false)}
          onImportComplete={() => {
            completeSetup();
            navigate("/home");
          }}
        />
      </div>
    </div>
  );
}
