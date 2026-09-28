import type { ReactNode } from "react";

import { TableCell } from "../../../components/ui/table";
import { cn } from "../../../lib/utils";

export function TextCell({
  className,
  align = "start",
  children,
}: {
  readonly className?: string;
  readonly align?: "start" | "end";
  readonly children: ReactNode;
}) {
  const content = <span className={cn("block", className)}>{children}</span>;
  return align === "end" ? (
    <TableCell className="text-right">{content}</TableCell>
  ) : (
    <TableCell>{content}</TableCell>
  );
}
