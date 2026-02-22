import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import { SetupSteps } from "../components/setup/SetupSteps";
import { WelcomeStep } from "../components/setup/WelcomeStep";
import { RcloneConfigStep } from "../components/setup/RcloneConfigStep";
import { ApiKeysStep } from "../components/setup/ApiKeysStep";
import { LibrariesStep } from "../components/setup/LibrariesStep";
import { GoogleSignInStep } from "../components/setup/GoogleSignInStep";
import { useAppStore } from "../store/appStore";

const STEPS = [
  { number: 1, label: "Welcome" },
  { number: 2, label: "Config" },
  { number: 3, label: "API Keys" },
  { number: 4, label: "Libraries" },
  { number: 5, label: "Sync" },
];

export function SetupPage() {
  const [currentStep, setCurrentStep] = useState(1);
  const { completeSetup } = useAppStore();
  const navigate = useNavigate();

  const next = () => setCurrentStep((s) => s + 1);
  const back = () => setCurrentStep((s) => s - 1);

  const handleFinish = () => {
    completeSetup();
    navigate("/home");
  };

  return (
    <div className="min-h-screen bg-void bg-noise flex flex-col">
      {/* Ambient background glow */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-accent/5 blur-[100px] rounded-full" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] bg-teal/3 blur-[120px] rounded-full" />
      </div>

      {/* Header */}
      <div className="relative z-10 flex items-center justify-between px-8 pt-8">
        <span className="font-display text-2xl text-accent tracking-widest">
          RCFLIX
        </span>
        {currentStep > 1 && (
          <div className="flex items-center">
            <SetupSteps steps={STEPS} currentStep={currentStep} />
          </div>
        )}
        <div className="w-16" /> {/* spacer */}
      </div>

      {/* Step content */}
      <div className="flex-1 flex items-center justify-center px-8 py-12 relative z-10">
        <div className="w-full max-w-2xl">
          <AnimatePresence mode="wait">
            {currentStep === 1 && (
              <motion.div key="step1">
                <WelcomeStep onNext={next} />
              </motion.div>
            )}
            {currentStep === 2 && (
              <motion.div key="step2">
                <RcloneConfigStep onNext={next} onBack={back} />
              </motion.div>
            )}
            {currentStep === 3 && (
              <motion.div key="step3">
                <ApiKeysStep onNext={next} onBack={back} />
              </motion.div>
            )}
            {currentStep === 4 && (
              <motion.div key="step4">
                <LibrariesStep onNext={next} onBack={back} />
              </motion.div>
            )}
            {currentStep === 5 && (
              <motion.div key="step5">
                <GoogleSignInStep onNext={handleFinish} onBack={back} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Footer */}
      <div className="relative z-10 px-8 pb-6 text-center">
        <p className="text-subtle text-xs font-body">
          RcloneFlix v0.1.0 — Your data never leaves your device
        </p>
      </div>
    </div>
  );
}
