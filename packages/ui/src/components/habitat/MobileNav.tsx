import React from "react";
import { Link } from "react-router-dom";
import { Plus, BarChart3, Users, Activity, Home } from "lucide-react";

interface MobileNavProps {
  onAddTask: () => void;
  onStats: () => void;
  onAgents: () => void;
  onBoardSettings: () => void;
  boardName?: string;
  habitatId?: string;
}

export function MobileNav({
  onAddTask,
  onStats,
  onAgents: _onAgents,
  onBoardSettings: _onBoardSettings,
  boardName: _boardName,
  habitatId,
}: MobileNavProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background safe-area-bottom md:hidden">
      <div className="flex items-center justify-around px-2 py-2">
        <Link
          to="/"
          className="flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-muted-foreground active:bg-accent transition-colors"
        >
          <Home className="h-5 w-5" />
          <span className="text-[10px]">Habitats</span>
        </Link>
        <button
          type="button"
          onClick={onStats}
          className="flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-muted-foreground active:bg-accent transition-colors"
        >
          <BarChart3 className="h-5 w-5" />
          <span className="text-[10px]">Stats</span>
        </button>
        <button
          type="button"
          onClick={onAddTask}
          className="flex items-center justify-center rounded-full bg-primary p-3 text-primary-foreground shadow-lg active:scale-95 transition-transform"
        >
          <Plus className="h-6 w-6" />
        </button>
        <Link
          to="/agents"
          className="flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-muted-foreground active:bg-accent transition-colors"
        >
          <Users className="h-5 w-5" />
          <span className="text-[10px]">Agents</span>
        </Link>
        <Link
          to={habitatId ? `/habitats/${habitatId}/activity` : "/"}
          className="flex flex-col items-center gap-0.5 rounded-md px-3 py-1.5 text-muted-foreground active:bg-accent transition-colors"
        >
          <Activity className="h-5 w-5" />
          <span className="text-[10px]">Activity</span>
        </Link>
      </div>
    </div>
  );
}
