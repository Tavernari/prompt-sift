import { evaluatePolicy, denialMessage } from "./policy.js";

function allowOutput(host) {
  if (host === "claude") return {};
  return host === "cursor"
    ? { permission: "allow" }
    : { permissionDecision: "allow" };
}

function denyOutput(host, reason) {
  if (host === "claude") return { hookSpecificOutput: {
    hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason
  } };
  return host === "cursor"
    ? { permission: "deny", user_message: reason, agent_message: reason }
    : { permissionDecision: "deny", permissionDecisionReason: reason };
}

export async function evaluateHook(host, payload, config) {
  if (!new Set(["cursor", "copilot", "claude"]).has(host)) {
    throw new Error("--host must be cursor, copilot or claude");
  }
  const result = await evaluatePolicy(payload, config);
  return result.allow ? allowOutput(host) : denyOutput(host, denialMessage(result, host));
}
