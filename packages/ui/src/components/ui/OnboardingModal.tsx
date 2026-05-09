import React, { useEffect, useState } from 'react';
import { LayoutGrid, ListTodo, Bot, CheckCircle, X } from 'lucide-react';
import { Button } from './Button.js';
import { AgentRegistrationDialog } from './AgentRegistrationDialog.js';

interface OnboardingModalProps {
  isOpen: boolean;
  onComplete: () => void;
}

const steps = [
  {
    icon: LayoutGrid,
    title: 'Create a Habitat',
    description: 'Set up a project or sprint board',
    action: null,
  },
  {
    icon: ListTodo,
    title: 'Add Tasks',
    description: 'Define work with clear descriptions and priorities',
    action: null,
  },
  {
    icon: Bot,
    title: 'Connect an Agent',
    description: 'Register an AI agent and configure MCP',
    action: 'register-agent',
  },
  {
    icon: CheckCircle,
    title: 'Review Results',
    description: 'Approve or reject agent submissions',
    action: null,
  },
];

export function OnboardingModal({ isOpen, onComplete }: OnboardingModalProps) {
  const [showAgentDialog, setShowAgentDialog] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onComplete();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onComplete]);

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="fixed inset-0 bg-black/50" aria-hidden="true" />
        <div
          className="relative z-50 w-full max-w-md rounded-lg bg-background p-6 shadow-lg animate-in fade-in zoom-in-95 duration-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="onboarding-title"
        >
          <button
            onClick={onComplete}
            className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="text-center">
            <h2 id="onboarding-title" className="text-2xl font-bold">
              Welcome to Orcy
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Task orchestration where AI agents self-serve work, with human review
            </p>
          </div>

          <div className="mt-6 space-y-4">
            {steps.map((step, index) => (
              <div key={step.title} className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <step.icon className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{index + 1}.</span>
                    <h3 className="text-sm font-semibold">{step.title}</h3>
                    {step.action === 'register-agent' && (
                      <button
                        onClick={() => setShowAgentDialog(true)}
                        className="ml-auto rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        Register
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{step.description}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-col items-center gap-3">
            <Button onClick={onComplete} className="w-full">
              Get Started
            </Button>
            <button
              onClick={onComplete}
              className="text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              Learn More
            </button>
          </div>
        </div>
      </div>

      <AgentRegistrationDialog
        open={showAgentDialog}
        onClose={() => setShowAgentDialog(false)}
        onRegistered={() => {}}
      />
    </>
  );
}
