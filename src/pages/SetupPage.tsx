import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useAppStore } from "../store/appStore";
import { GoogleSignInStep } from "../components/setup/GoogleSignInStep";
import { WelcomeStep } from "../components/setup/WelcomeStep";
import { RcloneConfigStep } from "../components/setup/RcloneConfigStep";
import { ApiKeysStep } from "../components/setup/ApiKeysStep";
import { LibrariesStep } from "../components/setup/LibrariesStep";
import { SetupSteps } from "../components/setup/SetupSteps";

const STEPS = [
  { number: 1, id: "google",    label: "Sign In" },
  { number: 2, id: "rclone",   label: "Rclone" },
  { number: 3, id: "apikeys",  label: "API Keys" },
  { number: 4, id: "libraries",label: "Libraries" },
] as const;

type StepId = typeof STEPS[number]["id"];

export function SetupPage() {
  const [stepId, setStepId] = useState<StepId>("google");
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
    <div className="min-h-screen bg-void flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
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
            {stepId === "google" && (
              <GoogleSignInStep isFirstStep onNext={next} onSkip={next} />
            )}
            {stepId === "rclone" && (
              <RcloneConfigStep onNext={next} onBack={prev} />
            )}
            {stepId === "apikeys" && (
              <ApiKeysStep onNext={next} onBack={prev} />
            )}
            {stepId === "libraries" && (
              <LibrariesStep onNext={finish} onBack={prev} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
