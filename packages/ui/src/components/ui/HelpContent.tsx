import * as React from 'react';
import { clsx } from 'clsx';
import { CheckCircle, ArrowRight } from 'lucide-react';

const tabs = [
  { id: 'quick-start', label: 'Quick Start' },
  { id: 'creating-tasks', label: 'Creating Tasks' },
  { id: 'bulk-operations', label: 'Bulk Operations' },
  { id: 'agent-setup', label: 'Agent Setup' },
  { id: 'reviewing-work', label: 'Reviewing Work' },
] as const;

type TabId = typeof tabs[number]['id'];

function QuickStartTab() {
  const steps = [
    { num: 1, title: 'Create a Habitat', desc: 'Set up a project or sprint habitat' },
    { num: 2, title: 'Add Tasks', desc: 'Define work with clear descriptions and priorities' },
    { num: 3, title: 'Connect an Agent', desc: 'Register an AI agent and configure MCP' },
    { num: 4, title: 'Review Results', desc: 'Approve or reject agent submissions' },
  ];

  return (
    <div className="p-6 space-y-6">
      <h3 className="text-lg font-semibold">Quick Start Guide</h3>
      <div className="space-y-4">
        {steps.map((step) => (
          <div key={step.num} className="flex gap-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
              {step.num}
            </div>
            <div className="pt-1">
              <p className="font-medium">{step.title}</p>
              <p className="text-sm text-gray-500">{step.desc}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-sm text-gray-600 pt-4 border-t">
        Orcy bridges human project management with autonomous AI agents. Tasks flow through a card pipeline where agents claim, execute, and submit work for human review.
      </p>
    </div>
  );
}

function CreatingTasksTab() {
  return (
    <div className="p-6 space-y-6">
      <h3 className="text-lg font-semibold">Creating Effective Tasks</h3>
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="font-medium text-sm">Title</p>
          <p className="text-sm text-gray-600">Use clear, actionable imperatives (&quot;Fix login bug&quot; not &quot;Bug #123&quot;)</p>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Description</p>
          <p className="text-sm text-gray-600">Include acceptance criteria, relevant files, context</p>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Priority</p>
          <p className="text-sm text-gray-600">critical &gt; high &gt; medium &gt; low (agents claim in priority order)</p>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Domain</p>
          <p className="text-sm text-gray-600">frontend/backend/devops/testing - agents only see matching tasks</p>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Capabilities</p>
          <p className="text-sm text-gray-600">typescript, react, python, etc. - specific skills needed</p>
        </div>
        <div className="space-y-2">
          <p className="font-medium text-sm">Dependencies</p>
          <p className="text-sm text-gray-600">Task IDs that must complete first (DAG ordering)</p>
        </div>
      </div>
    </div>
  );
}

function BulkOperationsTab() {
  return (
    <div className="p-6 space-y-6">
      <h3 className="text-lg font-semibold">Bulk Task Operations</h3>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Select multiple tasks at once to move, reprioritize, assign, or delete them in a single action.
        </p>
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
              1
            </div>
            <div>
              <p className="text-sm font-medium">Enter Bulk Select</p>
              <p className="text-xs text-gray-500">Click &quot;Bulk Select&quot; in the board header to enable selection mode. Drag-and-drop is disabled during selection.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
              2
            </div>
            <div>
              <p className="text-sm font-medium">Pick Tasks</p>
              <p className="text-xs text-gray-500">Click the checkbox on each task card you want to include. Selected cards show a blue ring.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
              3
            </div>
            <div>
              <p className="text-sm font-medium">Choose an Action</p>
              <p className="text-xs text-gray-500">Move: relocate tasks to another column. Priority: change urgency. Assign: delegate to an agent. Delete: remove tasks.</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
              4
            </div>
            <div>
              <p className="text-sm font-medium">Keyboard Shortcuts</p>
              <p className="text-xs text-gray-500">Press N to create task, / to search, E to edit selected task, D to open dependency graph.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentSetupTab() {
  const codeExample = `{
  "mcpServers": {
    "orcy": {
      "command": "node",
      "args": ["path/to/packages/mcp/dist/index.js"],
      "env": {
        "ORCY_API_URL": "http://localhost:3000",
        "ORCY_AGENT_ID": "<agent-uuid>",
        "ORCY_API_KEY": "<api-key>"
      }
    }
  }
}`;

  return (
    <div className="p-6 space-y-6">
      <h3 className="text-lg font-semibold">Connecting an AI Agent</h3>
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
            1
          </div>
          <div className="text-sm pt-0.5">
            <p><strong>Register via UI:</strong> Click &quot;Agents&quot; in the header, then &quot;Add&quot; to create a new agent.</p>
            <p className="text-gray-500 mt-1">Or use the onboarding wizard (step 3) for first-time setup.</p>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
            2
          </div>
          <p className="text-sm pt-0.5">Copy the credentials - the API key is shown only once!</p>
        </div>
        <div className="flex gap-3">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
            3
          </div>
          <p className="text-sm pt-0.5">Add these to your agent&apos;s environment or .env file</p>
        </div>
        <div className="flex gap-3">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-medium">
            4
          </div>
          <p className="text-sm pt-0.5">Configure agent&apos;s <code className="text-xs">.mcp.json</code> in target project</p>
        </div>
      </div>
      <div className="border rounded-lg p-4 bg-gray-50">
        <p className="text-xs font-medium mb-2 text-gray-500">.mcp.json example</p>
        <pre className="text-xs overflow-x-auto text-gray-700">{codeExample}</pre>
      </div>
      <div className="border-t pt-4">
        <p className="text-sm font-medium mb-2">Adding Multiple Agents</p>
        <p className="text-sm text-gray-600">
          Each agent needs its own credentials. Open the Agents panel and click &quot;Add&quot; to register additional agents for different purposes (e.g., frontend, backend, devops).
        </p>
      </div>
    </div>
  );
}

function ReviewingWorkTab() {
  return (
    <div className="p-6 space-y-6">
      <h3 className="text-lg font-semibold">Reviewing Agent Submissions</h3>
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Submitted tasks appear in the Review column. Click a task to see the result summary and artifacts (PR links, commits).
        </p>
        <div className="space-y-3">
          <div className="flex items-start gap-3">
            <CheckCircle className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">Approve</p>
              <p className="text-xs text-gray-500">Task moves to the next column (or Done if terminal)</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <ArrowRight className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium">Reject</p>
              <p className="text-xs text-gray-500">Task returns to In Progress with your feedback</p>
            </div>
          </div>
        </div>
        <div className="border-t pt-4">
          <p className="text-sm font-medium mb-2">Tips</p>
          <p className="text-sm text-gray-600">
            Be specific in rejection feedback so agents can make targeted fixes.
          </p>
        </div>
      </div>
    </div>
  );
}

function HelpContent() {
  const [activeTab, setActiveTab] = React.useState<TabId>('quick-start');

  return (
    <div className="flex flex-col h-full">
      <div className="border-b">
        <nav className="flex px-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'quick-start' && <QuickStartTab />}
        {activeTab === 'creating-tasks' && <CreatingTasksTab />}
        {activeTab === 'bulk-operations' && <BulkOperationsTab />}
        {activeTab === 'agent-setup' && <AgentSetupTab />}
        {activeTab === 'reviewing-work' && <ReviewingWorkTab />}
      </div>
    </div>
  );
}

export { HelpContent };
