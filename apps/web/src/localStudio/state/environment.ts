import type { EnvironmentId } from "@t3tools/contracts";

import { useActiveEnvironmentId } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";

export function useLocalAiEnvironmentId(): EnvironmentId | null {
  const active = useActiveEnvironmentId();
  const primary = usePrimaryEnvironmentId();
  return active ?? primary;
}
