import { CodeEvidencePanel } from "./CodeEvidencePanel.js";

interface MissionCodeEvidenceProps {
  missionId: string;
}

export function MissionCodeEvidence({ missionId }: MissionCodeEvidenceProps) {
  return <CodeEvidencePanel targetType="mission" targetId={missionId} />;
}
