import type { AnyProviderDriver } from "../ProviderDriver.ts";

export type LocalStudioDriversEnv = never;

export const LOCAL_STUDIO_DRIVERS: ReadonlyArray<AnyProviderDriver<LocalStudioDriversEnv>> = [];

export { localStudioProviderSyncLayer } from "./LocalStudioProviderSync.ts";
