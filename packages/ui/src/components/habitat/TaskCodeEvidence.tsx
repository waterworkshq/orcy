import { CodeEvidencePanel } from "./CodeEvidencePanel.js";

interface TaskCodeEvidenceProps {
  taskId: string;
}

export function TaskCodeEvidence({ taskId }: TaskCodeEvidenceProps) {
  return <CodeEvidencePanel targetType="task" targetId={taskId} />;
}
