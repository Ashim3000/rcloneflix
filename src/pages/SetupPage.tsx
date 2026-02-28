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

const STEPS = ["welcome", "google", "rclone", "apikeys", "libraries"] as const;
type Step = typeof STEPS[number];

export function SetupPage() {
  const [step, setStep] = useState<Step>("google"); // Google first
  const { completeSetup, setupComplete, googleAccount } = useAppStore();
  const navigate = useNavigate();

  const stepIndex = STEPS.indexOf(step);

  const next = () => {
    const nextStep = STEPS[stepIndex + 1];
    if (nextStep) setStep(nextStep);
    else finish();
  };

  const prev = () => {
    const prevStep = STEPS[stepIndex - 1];
    if (prevStep) setStep(prevStep);
  };

  const finish = () => {
    completeSetup();
    navigate("/home");
  };

  return (
    <div className="min-h-screen bg-void flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        {/* Progress dots */}
        <div className="flex justify-center mb-10">
          <SetupSteps
            steps={STEPS.map((s) => ({
              id: s,
              label: s.charAt(0).toUpperCase() + s.slice(1),
            }))}
            currentStep={step}
            onStepClick={(id) => setStep(id as Step)}
          />
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.25 }}
          >
            {step === "google" && (
              <GoogleSignInStep
                isFirstStep
                onNext={next}
                onSkip={next}
              />
            )}
            {step === "welcome" && <WelcomeStep onNext={next} />}
            {step === "rclone" && <RcloneConfigStep onNext={next} onBack={prev} />}
            {step === "apikeys" && <ApiKeysStep onNext={next} onBack={prev} />}
            {step === "libraries" && <LibrariesStep onNext={finish} onBack={prev} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
