import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { useToastStore, type Toast } from "../store/toastStore";

const icons = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const borderColors = {
  success: "border-teal",
  error: "border-danger",
  info: "border-accent",
};

const iconColors = {
  success: "text-teal",
  error: "text-danger",
  info: "text-accent",
};

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useToastStore((s) => s.removeToast);
  const Icon = icons[toast.type];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className={`flex items-start gap-3 bg-panel border ${borderColors[toast.type]} rounded-xl px-4 py-3 shadow-card-hover min-w-[280px] max-w-[360px]`}
    >
      <Icon size={16} className={`${iconColors[toast.type]} flex-shrink-0 mt-0.5`} />
      <p className="font-body text-sm text-text flex-1 leading-snug">{toast.message}</p>
      <button
        onClick={() => removeToast(toast.id)}
        className="text-subtle hover:text-text transition-colors flex-shrink-0 ml-1"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div className="fixed bottom-20 right-4 z-50 flex flex-col gap-2 items-end pointer-events-none">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <div key={toast.id} className="pointer-events-auto">
            <ToastItem toast={toast} />
          </div>
        ))}
      </AnimatePresence>
    </div>
  );
}
