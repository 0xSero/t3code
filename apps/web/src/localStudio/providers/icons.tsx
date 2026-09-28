import { CpuIcon } from "lucide-react";
import type { SVGProps } from "react";

import type { Icon } from "../../components/Icons";
import { cn } from "../../lib/utils";

export const LocalAiIcon: Icon = ({ className, ...props }: SVGProps<SVGSVGElement>) => (
  <CpuIcon {...props} className={cn("text-foreground", className)} />
);

export const OmpIcon: Icon = ({ className, ...props }) => (
  <svg {...props} viewBox="0 0 24 24" fill="none" className={cn("text-foreground", className)}>
    <rect x="1.5" y="1.5" width="21" height="21" rx="5" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M6 15.5V9.5M6 9.5h3.2a2 2 0 0 1 2 2v4M11.2 11.5a2 2 0 0 1 2-2h.8a2 2 0 0 1 2 2v4M16 11.5v-2h2"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const PiIcon: Icon = ({ className, ...props }) => (
  <svg {...props} viewBox="0 0 24 24" fill="none" className={cn("text-foreground", className)}>
    <path
      d="M4 7h16M9 7v11M15 7v8.5a2.5 2.5 0 0 0 2.5 2.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);
