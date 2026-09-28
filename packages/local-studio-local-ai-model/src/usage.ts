import type {
  DailyRow,
  GpuSample,
  HourlyRow,
  MetricsSummary,
  RequestRecord,
} from "@local-studio/contracts/client";

export const USAGE_WINDOWS = ["24h", "7d", "30d", "all"] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

export const USAGE_BREAKDOWNS = ["model", "client", "machine"] as const;
export type UsageBreakdown = (typeof USAGE_BREAKDOWNS)[number];

export const USAGE_WINDOW_DAYS: Record<UsageWindow, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  all: 3650,
};

export const GPU_SAMPLE_KEEP_DAYS = 7;

export interface TokenCounts {
  readonly inputUncached: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly cacheUnknownPrompt: number;
}

export const promptTokens = (row: TokenCounts): number =>
  row.inputUncached + row.cacheWrite + row.cacheUnknownPrompt;

export const allTokens = (row: TokenCounts): number =>
  promptTokens(row) + row.cacheRead + row.output;

export const ymd = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export interface UsageRange {
  readonly dailyFrom: string;
  readonly dailyTo: string;
  readonly gpuFrom: number | null;
}

export const usageRange = (window: UsageWindow, now = Date.now()): UsageRange => {
  const from = new Date(now);
  from.setDate(from.getDate() - (USAGE_WINDOW_DAYS[window] - 1));
  const to = new Date(now);
  to.setDate(to.getDate() + 1);
  const since = window === "24h" ? now - 86_400_000 : new Date(from).setHours(0, 0, 0, 0);
  return {
    dailyFrom: window === "all" ? "0000-01-01" : ymd(from),
    dailyTo: ymd(to),
    gpuFrom: USAGE_WINDOW_DAYS[window] <= GPU_SAMPLE_KEEP_DAYS ? since : null,
  };
};

export const sumSummaries = (
  summaries: ReadonlyArray<MetricsSummary>,
): TokenCounts & {
  readonly requests: number;
  readonly errors: number;
} =>
  summaries.reduce(
    (total, row) => ({
      inputUncached: total.inputUncached + row.inputUncached,
      cacheRead: total.cacheRead + row.cacheRead,
      cacheWrite: total.cacheWrite + row.cacheWrite,
      output: total.output + row.output,
      cacheUnknownPrompt: total.cacheUnknownPrompt + row.cacheUnknownPrompt,
      requests: total.requests + row.requests,
      errors: total.errors + row.errors,
    }),
    {
      inputUncached: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      cacheUnknownPrompt: 0,
      requests: 0,
      errors: 0,
    },
  );

export const cacheHitShare = (tokens: TokenCounts): number | null => {
  const prompt = tokens.inputUncached + tokens.cacheRead + tokens.cacheWrite;
  return prompt > 0 ? tokens.cacheRead / prompt : null;
};

export const gpuEnergyKwh = (samples: ReadonlyArray<GpuSample>): number =>
  samples.reduce((total, sample) => total + (sample.powerW ?? 0) / 60, 0) / 1000;

export interface UsageColumn {
  readonly label: string;
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

const columnOf = (label: string, rows: ReadonlyArray<TokenCounts>): UsageColumn => ({
  label,
  input: rows.reduce((total, row) => total + promptTokens(row), 0),
  cached: rows.reduce((total, row) => total + row.cacheRead, 0),
  output: rows.reduce((total, row) => total + row.output, 0),
});

export const usageColumns = (
  window: UsageWindow,
  daily: ReadonlyArray<DailyRow>,
  hourly: ReadonlyArray<HourlyRow>,
  now = Date.now(),
): UsageColumn[] => {
  if (window === "24h") {
    const start = Math.floor(now / 3_600_000) * 3_600_000 - 23 * 3_600_000;
    return Array.from({ length: 24 }, (_, index) => {
      const at = start + index * 3_600_000;
      return columnOf(
        `${String(new Date(at).getHours()).padStart(2, "0")}:00`,
        hourly.filter((row) => row.hour === at),
      );
    });
  }
  const days = [...new Set(daily.map((row) => row.day))].toSorted();
  const first = window === "all" ? days[0] : undefined;
  const count =
    window === "all" && first
      ? Math.ceil((now - new Date(first).getTime()) / 86_400_000) + 1
      : USAGE_WINDOW_DAYS[window];
  const step = count > 60 ? 7 : 1;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (count - 1));
  return Array.from({ length: Math.ceil(count / step) }, (_, index) => {
    const a = new Date(start);
    a.setDate(a.getDate() + index * step);
    const b = new Date(a);
    b.setDate(b.getDate() + step);
    return columnOf(
      `${a.toLocaleString("en", { month: "short" })} ${a.getDate()}`,
      daily.filter((row) => row.day >= ymd(a) && row.day < ymd(b)),
    );
  });
};

export interface BreakdownRow {
  readonly key: string;
  readonly tokens: number;
  readonly requests: number;
  readonly decodeTps: number | null;
}

export const usageBreakdown = (
  by: UsageBreakdown,
  entries: ReadonlyArray<{ readonly machine: string; readonly summary: MetricsSummary }>,
): BreakdownRow[] => {
  const map = new Map<string, { tokens: number; requests: number; dt: number; dm: number }>();
  const add = (
    key: string,
    row: TokenCounts & { requests: number; decodeTokens: number; decodeMs: number },
  ) => {
    const acc = map.get(key) ?? { tokens: 0, requests: 0, dt: 0, dm: 0 };
    acc.tokens += allTokens(row);
    acc.requests += row.requests;
    acc.dt += row.decodeTokens;
    acc.dm += row.decodeMs;
    map.set(key, acc);
  };
  for (const entry of entries) {
    if (by === "machine") add(entry.machine, entry.summary);
    else
      for (const slice of by === "model" ? entry.summary.byModel : entry.summary.byClient)
        add(slice.key, slice);
  }
  return [...map]
    .map(([key, acc]) => ({
      key,
      tokens: acc.tokens,
      requests: acc.requests,
      decodeTps: acc.dm > 0 ? acc.dt / (acc.dm / 1000) : null,
    }))
    .toSorted((a, b) => b.tokens - a.tokens || b.requests - a.requests);
};

export interface ConcurrencyRow {
  readonly label: string;
  readonly samples: number;
  readonly perRequest: number | null;
  readonly total: number | null;
}

export const decodeByConcurrency = (
  requests: ReadonlyArray<RequestRecord>,
): { readonly model: string; readonly rows: ConcurrencyRow[]; readonly n: number } | null => {
  const done = requests.filter(
    (row) => row.decodeTps !== null && row.tsFirstToken !== null && !row.errorCode,
  );
  const byModel = new Map<string, number>();
  for (const row of done) byModel.set(row.model, (byModel.get(row.model) ?? 0) + 1);
  const model = [...byModel].toSorted((a, b) => b[1] - a[1])[0]?.[0];
  if (!model) return null;
  const mine = done.filter((row) => row.model === model);
  const all = requests.filter((row) => row.model === model);
  const buckets: ReadonlyArray<readonly [string, number, number]> = [
    ["1", 1, 1],
    ["2", 2, 2],
    ["3–4", 3, 4],
    ["5–8", 5, 8],
    ["9+", 9, Number.POSITIVE_INFINITY],
  ];
  const rows = buckets
    .map(([label, lo, hi]) => {
      const points = mine
        .map((row) => {
          const mid = ((row.tsFirstToken ?? row.tsStart) + row.tsEnd) / 2;
          return {
            tps: row.decodeTps ?? 0,
            n: all.filter((other) => other.tsStart <= mid && other.tsEnd >= mid).length,
          };
        })
        .filter((point) => point.n >= lo && point.n <= hi);
      const sorted = points.map((point) => point.tps).toSorted((a, b) => a - b);
      const perRequest = sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? null) : null;
      const avg = points.length ? points.reduce((t, point) => t + point.n, 0) / points.length : 0;
      return {
        label,
        samples: points.length,
        perRequest,
        total: perRequest === null ? null : perRequest * avg,
      };
    })
    .filter((row) => row.samples >= 3);
  return rows.length ? { model, rows, n: mine.length } : null;
};
