import { motion } from "framer-motion";
import { Play, Cloud, BookOpen, Music } from "lucide-react";

type Props = {
  onNext: () => void;
};

const features = [
  {
    icon: Play,
    title: "Movies & TV",
    desc: "Stream from any rclone remote with TMDB metadata",
  },
  {
    icon: Music,
    title: "Music & Audiobooks",
    desc: "Full audio playback powered by libVLC",
  },
  {
    icon: BookOpen,
    title: "Books",
    desc: "Read EPUB and PDF files from your cloud storage",
  },
  {
    icon: Cloud,
    title: "Your Cloud, Your Rules",
    desc: "Bring your own rclone config — no data ever leaves your device",
  },
];

export function WelcomeStep({ onNext }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -24 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="flex flex-col items-center text-center max-w-2xl mx-auto"
    >
      {/* Logo / wordmark */}
      <div className="mb-8 relative">
        <div className="absolute -inset-8 rounded-full bg-accent/5 blur-3xl" />
        <h1 className="font-display text-8xl tracking-widest text-accent relative">
          RCLONE
          <span className="text-bright">FLIX</span>
        </h1>
        <p className="font-body text-subtle text-sm tracking-[0.3em] uppercase mt-1">
          Your Cloud. Your Media.
        </p>
      </div>

      <p className="text-text font-body text-lg leading-relaxed mb-12 max-w-md">
        Stream movies, TV shows, music, audiobooks, and books directly from
        your cloud storage — powered by rclone.
      </p>

      {/* Feature grid */}
      <div className="grid grid-cols-2 gap-4 w-full mb-12">
        {features.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.08, duration: 0.4 }}
            className="card p-5 text-left group"
          >
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center mb-3 group-hover:bg-accent/20 transition-colors">
              <f.icon size={20} className="text-accent" />
            </div>
            <h3 className="font-body font-semibold text-bright text-sm mb-1">
              {f.title}
            </h3>
            <p className="font-body text-subtle text-xs leading-relaxed">
              {f.desc}
            </p>
          </motion.div>
        ))}
      </div>

      <motion.button
        onClick={onNext}
        className="btn-primary text-base px-10 py-4 text-lg tracking-wide"
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
      >
        Get Started
      </motion.button>

      <p className="text-subtle text-xs mt-4 font-body">
        Takes about 2 minutes to set up
      </p>
    </motion.div>
  );
}
