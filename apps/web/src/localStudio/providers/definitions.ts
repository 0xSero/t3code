import type { ProviderDriverKind } from "@t3tools/contracts";

import type { Icon } from "../../components/Icons";
import type { ProviderClientDefinition } from "../../components/settings/providerDriverMeta";

export const LOCAL_STUDIO_PROVIDER_CLIENT_DEFINITIONS: readonly ProviderClientDefinition[] = [];

export const LOCAL_STUDIO_PROVIDER_ICONS: Partial<Record<ProviderDriverKind, Icon>> = {};
