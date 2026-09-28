export const LOCAL_AI_DRIVER_KIND = "localAi";
export const PI_DRIVER_KIND = "pi";
export const OMP_DRIVER_KIND = "omp";

export const LOCAL_STUDIO_DRIVER_KINDS = [
  LOCAL_AI_DRIVER_KIND,
  PI_DRIVER_KIND,
  OMP_DRIVER_KIND,
] as const;

export type LocalStudioDriverKind = (typeof LOCAL_STUDIO_DRIVER_KINDS)[number];

export const LOCAL_AI_PROVIDER_LABEL = "Local AI";
export const LOCAL_AI_ROUTE_PATH = "/local-ai";
export const LOCAL_AI_EMPTY_STATE_MESSAGE = "No local models running — open Local AI";
