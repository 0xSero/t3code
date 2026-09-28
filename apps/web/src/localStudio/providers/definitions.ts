import {
  LOCAL_AI_DRIVER_KIND,
  LOCAL_AI_PROVIDER_LABEL,
  LocalAiSettings,
  OMP_DRIVER_KIND,
  OmpSettings,
  PI_DRIVER_KIND,
  PiSettings,
} from "@local-studio/t3-providers";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { Icon } from "../../components/Icons";
import type { ProviderClientDefinition } from "../../components/settings/providerDriverMeta";
import { LocalAiIcon, OmpIcon, PiIcon } from "./icons";

const LOCAL_AI = ProviderDriverKind.make(LOCAL_AI_DRIVER_KIND);
const OMP = ProviderDriverKind.make(OMP_DRIVER_KIND);
const PI = ProviderDriverKind.make(PI_DRIVER_KIND);

export const LOCAL_STUDIO_PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] = [
  {
    value: LOCAL_AI,
    label: LOCAL_AI_PROVIDER_LABEL,
    icon: LocalAiIcon,
    settingsSchema: LocalAiSettings,
  },
  {
    value: OMP,
    label: "omp",
    icon: OmpIcon,
    settingsSchema: OmpSettings,
  },
  {
    value: PI,
    label: "pi",
    icon: PiIcon,
    settingsSchema: PiSettings,
  },
];

export const LOCAL_STUDIO_PROVIDER_ICONS: Partial<Record<ProviderDriverKind, Icon>> = {
  [LOCAL_AI]: LocalAiIcon,
  [OMP]: OmpIcon,
  [PI]: PiIcon,
};
