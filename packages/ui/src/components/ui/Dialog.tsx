import * as React from "react";
import { clsx } from "clsx";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  contentClassName?: string;
  /** Optional override; auto-generated via React.useId() when omitted. */
  "aria-labelledby"?: string;
}

interface DialogContextValue {
  titleId: string;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Dialog({ open, onClose, children, contentClassName, "aria-labelledby": ariaLabelledBy }: DialogProps) {
  const generatedTitleId = React.useId();
  const titleId = ariaLabelledBy ?? generatedTitleId;
  const panelRef = React.useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = React.useRef<HTMLElement | null>(null);

  // Save / restore focus across open transitions
  React.useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;

    // Defer focus until after the panel mounts so focusable children are present
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const firstFocusable = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      if (firstFocusable) {
        firstFocusable.focus();
      } else {
        panel.focus();
      }
    });

    return () => {
      cancelAnimationFrame(raf);
      const previous = previouslyFocusedRef.current;
      if (previous && typeof previous.focus === "function" && document.contains(previous)) {
        previous.focus();
      }
    };
  }, [open]);

  // Escape to close + focus trap (Tab / Shift-Tab cycle within panel)
  React.useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) {
        // Keep focus inside the panel even if it has no focusable children
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <DialogContext.Provider value={{ titleId }}>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="fixed inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className={clsx(
            "relative z-50 w-full max-w-lg rounded-lg bg-background p-6 shadow-lg mobile-dialog-full outline-none",
            contentClassName,
          )}
        >
          {children}
        </div>
      </div>
    </DialogContext.Provider>
  );
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx("flex flex-col space-y-1.5 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />
  );
}

interface DialogTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** Optional override; auto-wired to the parent Dialog's generated ID when omitted. */
  id?: string;
}

function DialogTitle({ className, id, ...props }: DialogTitleProps) {
  const ctx = React.useContext(DialogContext);
  const fallbackId = React.useId();
  const titleId = id ?? ctx?.titleId ?? fallbackId;
  return (
    <h2
      id={titleId}
      className={clsx("text-lg font-semibold leading-none tracking-tight", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={clsx("text-sm text-muted-foreground", className)} {...props} />;
}

function DialogContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("mt-4", className)} {...props} />;
}

export { Dialog, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogContent };