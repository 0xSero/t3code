export type OmpApprovalMode = "always-ask" | "write" | "yolo";

export type LocalStudioRuntimeMode =
  | "approval-required"
  | "auto-accept-edits"
  | "auto"
  | "full-access"
  | (string & {});

export function ompApprovalModeFor(
  runtimeMode: LocalStudioRuntimeMode | undefined,
): OmpApprovalMode {
  switch (runtimeMode) {
    case "approval-required":
      return "always-ask";
    case "full-access":
      return "yolo";
    default:
      return "write";
  }
}

export function piNeedsApprovalGate(runtimeMode: LocalStudioRuntimeMode | undefined): boolean {
  return runtimeMode !== "full-access";
}
