import { motion } from "framer-motion";
import { Check } from "lucide-react";

type Step = {
  number: number;
  label: string;
};

type Props = {
  steps: Step[];
  currentStep: number;
};

export function SetupSteps({ steps, currentStep }: Props) {
  return (
    <div className="flex items-center gap-0">
      {steps.map((step, i) => {
        const isDone = currentStep > step.number;
        const isActive = currentStep === step.number;

        return (
          <div key={step.number} className="flex items-center">
            {/* Step circle */}
            <div className="flex flex-col items-center gap-2">
              <motion.div
                initial={false}
                animate={{
                  backgroundColor: isDone
                    ? "#E8A020"
                    : isActive
                    ? "#1E2535"
                    : "#0E1117",
                  borderColor: isDone
                    ? "#E8A020"
                    : isActive
                    ? "#E8A020"
                    : "#1E2535",
                }}
                className="step-indicator border-2"
              >
                {isDone ? (
                  <Check size={14} className="text-void" />
                ) : (
                  <span
                    className={
                      isActive ? "text-accent" : "text-subtle"
                    }
                  >
                    {step.number}
                  </span>
                )}
              </motion.div>
              <span
                className={`text-xs font-body whitespace-nowrap transition-colors duration-300 ${
                  isActive
                    ? "text-accent"
                    : isDone
                    ? "text-teal"
                    : "text-subtle"
                }`}
              >
                {step.label}
              </span>
            </div>

            {/* Connector line */}
            {i < steps.length - 1 && (
              <div className="w-16 h-px mb-5 mx-1 relative overflow-hidden">
                <div className="absolute inset-0 bg-border" />
                <motion.div
                  className="absolute inset-0 bg-accent"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: isDone ? 1 : 0 }}
                  style={{ transformOrigin: "left" }}
                  transition={{ duration: 0.4, ease: "easeInOut" }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
