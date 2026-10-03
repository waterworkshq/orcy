/**
 * Remote stream projection — the bounded wire a remote participant receives.
 *
 * A remote stream NEVER forwards the local Habitat event payload. It emits one
 * minimal notice naming an entity that the recipient can currently read:
 *
 *     {"type":"remote.entity_changed","data":{"targetType":"task","targetId":"<id>"}}
 *
 * `targetId` is the exact persisted id fetched from the database, never an
 * alias spelling and never a value taken from the incoming event's other
 * fields. No original event type, status, action, timestamp, version, actor,
 * comment/subtask/evidence id, title, reason, metadata, linked object id,
 * scope/grant id, or raw event fragment is copied.
 *
 * The shape declared here is a SEPARATE remote wire DTO. It is deliberately not
 * added to the local `SSEEvent` union or the UI event registry: serializing it
 * through the local catalog would change closed local consumers for no benefit.
 *
 * A notice is a HINT, not a disclosure. A recipient needs its own authorized
 * shared GET to learn anything about the entity, and a Mission notice implies
 * nothing about its child Tasks. Notice frequency reveals activity on an
 * admitted entity; no anonymity or traffic-analysis resistance is claimed.
 */

/** The single remote event type. */
export const REMOTE_STREAM_EVENT_TYPE = "remote.entity_changed";

export interface RemoteEntityChangedData {
  targetType: "task" | "mission";
  targetId: string;
}

export interface RemoteStreamEvent {
  type: typeof REMOTE_STREAM_EVENT_TYPE;
  data: RemoteEntityChangedData;
}

/** The primary-target field an allowlisted event carries. */
type PrimaryIdField = "id" | "taskId" | "missionId";

interface AllowlistEntry {
  /** Discriminator to emit, except for code evidence which carries its own. */
  targetType: "task" | "mission" | "code_evidence";
  idField?: PrimaryIdField;
}

const task = (idField: PrimaryIdField): AllowlistEntry => ({ targetType: "task", idField });
const mission = (idField: PrimaryIdField): AllowlistEntry => ({ targetType: "mission", idField });

/**
 * The closed initial allowlist. Membership is by EXACT event type — there is no
 * `task.*`/`mission.*` wildcard and no generic recursive id discovery, so an
 * unknown future type is suppressed until it is deliberately added here.
 *
 * Everything absent from this table is suppressed, including: Task/Mission
 * deletion (a deleted target cannot satisfy existence/visibility, so a notice
 * would be a tombstone disclosure); `task.cloned` (two potential targets — the
 * bounded choice is suppression, and a separately emitted `task.created` for a
 * visible clone still produces the ordinary creation notice); watcher/mention
 * recipient events; Pulse including Experience Signals; agents and Agent Mail;
 * presence; Habitat/columns; webhook errors; schedules/sprints; and
 * wiki/plugins/triage/extraction events.
 */
export const REMOTE_STREAM_ALLOWLIST: Readonly<Record<string, AllowlistEntry>> = {
  // Whole-Task payloads carry the id directly.
  "task.created": task("id"),
  "task.updated": task("id"),

  // Task lifecycle and operational events reference the Task by id.
  "task.moved": task("taskId"),
  "task.claimed": task("taskId"),
  "task.submitted": task("taskId"),
  "task.approved": task("taskId"),
  "task.rejected": task("taskId"),
  "task.completed": task("taskId"),
  "task.failed": task("taskId"),
  "task.released": task("taskId"),
  "task.delegated": task("taskId"),
  "task.overdue": task("taskId"),
  "task.commented": task("taskId"),
  "task.comment_deleted": task("taskId"),
  "task.retry_scheduled": task("taskId"),
  "task.retry_executed": task("taskId"),
  "task.escalated": task("taskId"),
  "task.priority_changed": task("taskId"),
  "task.review_assigned": task("taskId"),
  "task.review_completed": task("taskId"),

  // Adjunct events project onto their owning Task.
  "subtask.created": task("taskId"),
  "subtask.updated": task("taskId"),
  "subtask.deleted": task("taskId"),
  "effort.updated": task("taskId"),

  // Whole-Mission payloads carry the id directly.
  "mission.created": mission("id"),
  "mission.updated": mission("id"),

  // Mission lifecycle and communication events reference the Mission by id.
  "mission.moved": mission("missionId"),
  "mission.status_changed": mission("missionId"),
  "mission.progress": mission("missionId"),
  "mission.commented": mission("missionId"),
  "mission.comment_deleted": mission("missionId"),

  // Code evidence carries its own exact discriminator.
  "code_evidence.updated": { targetType: "code_evidence" },
};

/** Exact allowlisted event types, in declaration order. */
export const REMOTE_STREAM_ALLOWLIST_TYPES: readonly string[] =
  Object.keys(REMOTE_STREAM_ALLOWLIST);

export interface RemotePrimaryTarget {
  targetType: "task" | "mission";
  targetId: string;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A primary id must be a genuinely nonempty string; no coercion from numbers. */
function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Extract at most ONE primary target from an incoming event, or null when the
 * event is suppressed.
 *
 * Only the fields that form the minimal DTO are inspected. Unrelated fields are
 * never validated and never authorized, because they are never emitted — a
 * full comment, failure reason, or linked hidden id riding along in an otherwise
 * allowed payload cannot leak, since none of it is read.
 */
export function extractRemotePrimaryTarget(event: unknown): RemotePrimaryTarget | null {
  if (!isRecordObject(event)) return null;

  const type = asNonEmptyString(event.type);
  if (type === null) return null;

  const entry = Object.hasOwn(REMOTE_STREAM_ALLOWLIST, type)
    ? REMOTE_STREAM_ALLOWLIST[type]
    : undefined;
  if (!entry) return null;

  const data = event.data;
  if (!isRecordObject(data)) return null;

  if (entry.targetType === "code_evidence") {
    const targetType = data.targetType;
    if (targetType !== "task" && targetType !== "mission") return null;
    const targetId = asNonEmptyString(data.targetId);
    if (targetId === null) return null;
    return { targetType, targetId };
  }

  const targetId = asNonEmptyString(data[entry.idField!]);
  if (targetId === null) return null;
  return { targetType: entry.targetType, targetId };
}

/**
 * Construct the remote notice FROM SCRATCH. This is the only constructor, and it
 * takes exactly the two values that may leave the server — so a spread of the
 * input event followed by field deletion is not expressible here.
 */
export function buildRemoteEntityChanged(
  targetType: "task" | "mission",
  targetId: string,
): RemoteStreamEvent {
  return {
    type: REMOTE_STREAM_EVENT_TYPE,
    data: { targetType, targetId },
  };
}
