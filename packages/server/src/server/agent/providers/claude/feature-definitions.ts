import type { AgentFeature, AgentFeatureToggle } from "../../agent-sdk-types.js";
import { claudeManifestModelSupportsFastMode } from "./model-manifest.js";

export const CLAUDE_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export const CLAUDE_ULTRACODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "ultracode",
  label: "Ultracode",
  description: "Standing multi-agent workflow orchestration for this session, at any effort level",
  tooltip: "Toggle ultracode",
  icon: "list-todo",
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return claudeManifestModelSupportsFastMode(modelId);
}

export function buildClaudeFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  ultracodeEnabled: boolean;
}): AgentFeature[] {
  const ultracode: AgentFeature = { ...CLAUDE_ULTRACODE_FEATURE, value: input.ultracodeEnabled };
  if (!claudeModelSupportsFastMode(input.modelId)) {
    return [ultracode];
  }

  return [
    {
      ...CLAUDE_FAST_MODE_FEATURE,
      value: input.fastModeEnabled,
    },
    ultracode,
  ];
}
