import { KanbanApiClient } from "./api.js";
import {
  REMOTE_MCP_ACTIONS,
  isRemoteMcpAction,
  type RemoteMcpAction,
  type RemoteActionDescriptor,
} from "./remote-actions.js";

/**
 * v0.19 Phase D — RemoteMcpClient.
 *
 * Thin wrapper around the local KanbanApiClient that exposes ONLY the
 * actions defined in the remote allowlist. Each call:
 *  1. Validates the action is in the allowlist (refuses unknown actions)
 *  2. Builds the correct /api/shared/* path
 *  3. Auto-generates an Idempotency-Key header for write actions
 *  4. Sends the X-Orcy-Remote-Key auth header via requestRemote()
 *
 * The local agent path (X-Agent-API-Key) is NEVER used here. There is
 * no method on this class that can hit non-/api/shared/* routes.
 */
export class RemoteMcpClient {
  constructor(private readonly client: KanbanApiClient) {}

  /**
   * Execute a remote MCP action by name with the given parameters.
   * Returns the parsed JSON response. Throws if the action is unknown,
   * or if the server returns a non-2xx status (the underlying transport
   * throws an ApiClientError).
   */
  async execute<T = unknown>(
    action: string,
    params: Record<string, string> = {},
    bodyParams: Record<string, unknown> = {},
  ): Promise<T> {
    if (!isRemoteMcpAction(action)) {
      throw new Error(
        `Unknown remote MCP action: ${action}. ` +
          `Allowed actions: ${Object.keys(REMOTE_MCP_ACTIONS).join(", ")}`,
      );
    }
    return this.executeAllowed<T>(action, params, bodyParams);
  }

  /**
   * Type-narrowed version of execute() for callers that already know the
   * action is in the allowlist.
   */
  async executeAllowed<T = unknown>(
    action: RemoteMcpAction,
    params: Record<string, string> = {},
    bodyParams: Record<string, unknown> = {},
  ): Promise<T> {
    const descriptor: RemoteActionDescriptor = REMOTE_MCP_ACTIONS[action];
    const path = descriptor.path(params);
    const body = descriptor.bodyFrom ? descriptor.bodyFrom(bodyParams) : undefined;

    return this.client.requestRemote<T>(descriptor.method, path, {
      body,
      action: descriptor.requiredScope,
    });
  }

  /**
   * List all known remote actions — useful for tool discovery and
   * documentation generation.
   */
  listActions(): Array<{
    action: RemoteMcpAction;
    method: "GET" | "POST";
    requiredScope: string;
  }> {
    return Object.entries(REMOTE_MCP_ACTIONS).map(([action, desc]) => ({
      action: action as RemoteMcpAction,
      method: desc.method,
      requiredScope: desc.requiredScope,
    }));
  }
}
