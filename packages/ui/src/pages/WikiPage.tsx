import { useParams, useSearchParams, Link } from "react-router-dom";
import { ArrowLeft, BookOpen, Loader2, Signal, FlaskConical, FileText, Radar } from "lucide-react";
import { useBoard } from "../lib/useHabitatData.js";
import { WikiBrowser } from "../components/wiki/WikiBrowser.js";
import { WikiPageViewer } from "../components/wiki/WikiPageViewer.js";
import { WikiEditor } from "../components/wiki/WikiEditor.js";
import { CadencePanel } from "../components/wiki/CadencePanel.js";
import { ExperienceSignalsTab } from "../components/wiki/ExperienceSignalsTab.js";
import { EngineeringFindingsTab } from "../components/wiki/EngineeringFindingsTab.js";
import { DetectedSignalsTab } from "../components/wiki/DetectedSignalsTab.js";

type Tab = "pages" | "experience" | "findings" | "detected";

const TABS: Array<{ id: Tab; label: string; icon: typeof FileText }> = [
  { id: "pages", label: "Pages", icon: FileText },
  { id: "experience", label: "Experience Signals", icon: Signal },
  { id: "findings", label: "Engineering Findings", icon: FlaskConical },
  { id: "detected", label: "Detected Signals", icon: Radar },
];

export function WikiPage() {
  const { habitatId } = useParams<{ habitatId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: boardData } = useBoard(habitatId);

  const activePageId = searchParams.get("page");
  const isEditing = searchParams.get("edit") === "true";
  const isCreateMode = activePageId === "new";
  const tab = (searchParams.get("tab") as Tab | null) ?? "pages";

  if (!habitatId) {
    return (
      <div className="flex items-center justify-center py-20 text-[var(--on-surface-variant)]">
        No habitat selected.
      </div>
    );
  }

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    if (next === "pages") {
      params.delete("tab");
    } else {
      params.set("tab", next);
      params.delete("page");
    }
    setSearchParams(params, { replace: true });
  };

  const closePage = () => {
    const params = new URLSearchParams(searchParams);
    params.delete("page");
    params.delete("edit");
    setSearchParams(params, { replace: true });
  };

  const openEditor = (pageId: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", pageId);
    params.set("edit", "true");
    params.delete("tab");
    setSearchParams(params, { replace: false });
  };

  const openCreate = () => {
    const params = new URLSearchParams(searchParams);
    params.set("page", "new");
    params.delete("edit");
    params.delete("tab");
    setSearchParams(params, { replace: false });
  };

  const viewPage = (pageId: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("page", pageId);
    params.delete("edit");
    setSearchParams(params, { replace: false });
  };

  const habitatName = boardData?.board.name ?? "Habitat";

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <div className="sticky top-0 z-10 glass-panel border-b border-[var(--outline-variant)] px-4 py-3 flex items-center gap-3">
        <Link to={`/habitats/${habitatId}`}>
          <button
            type="button"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold text-[var(--on-surface-variant)] hover:text-[var(--on-surface)] hover:bg-[var(--surface-container-high)] transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
        </Link>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-[var(--primary)]" />
          {habitatName} Wiki
        </h1>
      </div>

      <div className="max-w-5xl mx-auto py-6 px-4">
        {isCreateMode ? (
          <WikiEditor
            habitatId={habitatId}
            mode="create"
            onDone={(newId) => viewPage(newId)}
            onCancel={closePage}
          />
        ) : activePageId && isEditing ? (
          <WikiEditor
            habitatId={habitatId}
            mode="edit"
            pageId={activePageId}
            onDone={(id) => viewPage(id)}
            onCancel={() => viewPage(activePageId)}
          />
        ) : activePageId ? (
          <WikiPageViewer
            habitatId={habitatId}
            pageId={activePageId}
            onBack={closePage}
            onEdit={() => openEditor(activePageId)}
          />
        ) : (
          <>
            <CadencePanel habitatId={habitatId} />
            <div role="tablist" className="flex border-b border-[var(--outline-variant)] mb-4 mt-3">
              {TABS.map(({ id, label, icon: Icon }) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(id)}
                    className={`flex-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${
                      active
                        ? "text-[var(--primary)] border-b-2 border-[var(--primary)] bg-[var(--surface-container)]/40"
                        : "text-[var(--on-surface-variant)] hover:text-[var(--on-surface)]"
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                );
              })}
            </div>

            <div role="tabpanel">
              {tab === "pages" && <WikiBrowser habitatId={habitatId} onCreatePage={openCreate} />}
              {tab === "experience" && <ExperienceSignalsTab habitatId={habitatId} />}
              {tab === "findings" && <EngineeringFindingsTab habitatId={habitatId} />}
              {tab === "detected" && <DetectedSignalsTab habitatId={habitatId} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
