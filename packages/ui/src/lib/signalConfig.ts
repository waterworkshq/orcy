import { SIGNAL_TYPES, type SignalType } from "@orcy/shared";

export { SIGNAL_TYPES };

export const SIGNAL_LABELS: Record<SignalType, string> = {
  finding: "Finding",
  blocker: "Blocker",
  offer: "Offer",
  warning: "Warning",
  question: "Question",
  answer: "Answer",
  directive: "Directive",
  context: "Context",
  handoff: "Handoff",
  experience: "Experience",
  detected: "Detected",
};

/** CSS variable-based colors matching the Obsidian Glass design system */
export const SIGNAL_COLORS: Record<SignalType, string> = {
  finding: "var(--primary)",
  blocker: "var(--error)",
  offer: "var(--tertiary)",
  warning: "hsl(40,90%,55%)",
  question: "var(--secondary)",
  answer: "var(--secondary)",
  directive: "hsl(280,70%,60%)",
  context: "var(--on-surface-variant)",
  handoff: "hsl(200,70%,60%)",
  experience: "var(--on-surface-variant)",
  detected: "hsl(160,60%,50%)",
};

/** Hex-based colors for use outside CSS variable context */
export const SIGNAL_CONFIG: Record<SignalType, { label: string; icon: string; color: string }> = {
  finding: { label: "Finding", icon: "Search", color: "#4fc3f7" },
  blocker: { label: "Blocker", icon: "AlertOctagon", color: "#ef5350" },
  offer: { label: "Offer", icon: "Handshake", color: "#66bb6a" },
  warning: { label: "Warning", icon: "AlertTriangle", color: "#ffa726" },
  question: { label: "Question", icon: "HelpCircle", color: "#ab47bc" },
  answer: { label: "Answer", icon: "CheckCircle", color: "#26a69a" },
  directive: { label: "Directive", icon: "Milestone", color: "#ff7043" },
  context: { label: "Context", icon: "Info", color: "#78909c" },
  handoff: { label: "Handoff", icon: "ArrowRightLeft", color: "#5c6bc0" },
  experience: { label: "Experience", icon: "Lightbulb", color: "#78909c" },
  detected: { label: "Detected", icon: "ScanLine", color: "#26a69a" },
};
