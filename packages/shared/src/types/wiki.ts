/** Published-state values for a habitat-scoped Wiki Page. */
export type WikiPageStatus = "draft" | "published";

/** Coverage-marker meanings used by the wiki cadence watermark. */
export type WikiCoverageMarkerType = "page" | "no_update_needed";

/** Runtime list of source primitive types that a Wiki Page Link can cite. */
export const WIKI_LINK_TARGET_TYPES = [
  "mission",
  "task",
  "pulse",
  "insight",
  "skill_signal",
  "commit",
  "pull_request",
  "evidence_link",
  "external_issue",
] as const;

/** Controlled source primitive type for a polymorphic Wiki Page Link citation. */
export type WikiLinkTargetType = (typeof WIKI_LINK_TARGET_TYPES)[number];

/** Current denormalized state for an authored habitat Wiki Page. */
export interface WikiPage {
  id: string;
  habitatId: string;
  parentId: string | null;
  slug: string;
  title: string;
  content: string;
  status: WikiPageStatus;
  tags: string[];
  currentVersionNumber: number;
  createdBy: string;
  lastUpdatedBy: string;
  lastUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Append-only content snapshot for a Wiki Page save or restore operation. */
export interface WikiPageVersion {
  id: string;
  pageId: string;
  versionNumber: number;
  title: string;
  content: string;
  editSummary: string | null;
  editedBy: string;
  createdAt: string;
}

/** Polymorphic citation from a Wiki Page to a source primitive. */
export interface WikiPageLink {
  id: string;
  pageId: string;
  targetType: WikiLinkTargetType;
  targetId: string;
  linkNote: string | null;
  createdBy: string;
  createdAt: string;
}

/** Authored coverage record that advances or holds the wiki cadence watermark. */
export interface WikiCoverageMarker {
  id: string;
  habitatId: string;
  coverageFrom: string;
  coverageTo: string;
  markerType: WikiCoverageMarkerType;
  pageId: string | null;
  reason: string | null;
  createdBy: string;
  createdAt: string;
}
