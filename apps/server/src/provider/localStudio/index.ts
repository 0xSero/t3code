import type { AnyProviderDriver } from "../ProviderDriver.ts";
import {
  LocalAiDriver,
  OmpDriver,
  PiDriver,
  type LocalStudioAgentDriverEnv,
} from "./LocalStudioAgentDriver.ts";

export type LocalStudioDriversEnv = LocalStudioAgentDriverEnv;

export const LOCAL_STUDIO_DRIVERS: ReadonlyArray<AnyProviderDriver<LocalStudioDriversEnv>> = [
  LocalAiDriver,
  OmpDriver,
  PiDriver,
];

export { localStudioProviderSyncLayer } from "./LocalStudioProviderSync.ts";
