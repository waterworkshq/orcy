import type { MissionComment } from "../../types/index.js";

/** Same 4-way standing labels as mission comment cards. */
export function missionCommentAuthorLabel(comment: MissionComment): string {
  if (comment.authorType === "agent") return comment.authorId.slice(0, 8);
  if (comment.authorType === "remote_human") return `Remote: ${comment.authorId.slice(0, 8)}`;
  if (comment.authorType === "remote_orcy") return `Remote Or: ${comment.authorId.slice(0, 8)}`;
  return "Human";
}
