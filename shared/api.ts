import type {
  Annotation,
  Attempt,
  Observation,
  Rate,
  Segment,
} from "./types.ts";
import type { Coverage } from "./monitoring.ts";

export interface CollectorState {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  failures: number;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  nextRunAt: number | null;
  lastError: string | null;
  failureSince: number | null;
  recoveredAt: number | null;
}
export interface OperationState {
  id: string;
  state: "running" | "succeeded" | "failed" | "interrupted";
  startedAt: number;
  completedAt: number | null;
}
export interface ActivityScope {
  mode: "all" | "current";
  available: boolean;
  from: number | null;
  reset: number | null;
  account: string | null;
  reason: string;
}
export interface DashboardQuery {
  activityScope?: "all" | "current";
  historyScope?: "range" | "current";
  view?: "overview" | "activity" | "evidence" | "comparisons";
  days?: 7 | 30 | 90;
  window?: string;
  timezone?: string;
}
export interface BackupState {
  id: string;
  at: number;
  verified: boolean;
  automatic: boolean;
  retentionWarning: string | null;
}
export interface ScanState {
  at: number;
  files: number;
  bytes: number;
  indexedMissing: number;
  complete: boolean;
  failed: number;
}
export interface DashboardStatus {
  version: number;
  csrf: string;
  now: number;
  status: { scanning: boolean; refreshing: boolean };
  collector: CollectorState & { managed: boolean };
  importer: CollectorState;
  backup: { last: BackupState | null; error: string | null; running: boolean };
  operations: { scan: OperationState | null; backup: OperationState | null };
  attempts: Attempt[];
  scan: ScanState | null;
  windows: Observation[];
  snapshotId: string | null;
  identity: "provider" | "unknown" | null;
}
export interface UsageTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
  responses: number;
}
export interface UsageGroup extends UsageTotals {
  name: string;
  first: number;
  last: number;
  models: string[];
  system: boolean;
}
export interface UsageSummary extends UsageTotals {
  boundaryExcluded?: number;
  excluded: number;
  fallbackTokens: number;
  fallbackRecords: number;
  first: number | null;
  last: number;
  byModel: UsageGroup[];
  bySettings: UsageGroup[];
  sessions: UsageGroup[];
  days: UsageGroup[];
  recentTokensPerMinute: number;
  modelsTruncated?: boolean;
  settingsTruncated?: boolean;
}
export interface WindowHistory {
  key: string;
  history: Observation[];
  localHistory: Observation[];
  historyTruncated: boolean;
  localHistoryTruncated: boolean;
  rate: Rate;
}
export interface Comparison {
  status: string;
  caveat: string;
  truncated: boolean;
  rejected: Record<string, number>;
  pairs: { before: string; after: string; ratio: number; model: string }[];
  cohorts: {
    plan: string;
    model: string;
    median: number;
    min: number;
    max: number;
    windows: number;
    qualified: boolean;
  }[];
}
export interface DashboardDetails {
  activityScope?: ActivityScope;
  cycle?: ActivityScope;
  windows: Observation[];
  latest?: Observation;
  identity: DashboardStatus["identity"];
  snapshotId: string | null;
  history: Observation[];
  localHistory: Observation[];
  historyTruncated: boolean;
  localHistoryTruncated: boolean;
  rate: Rate;
  windowHistories: WindowHistory[];
  usage: UsageSummary;
  coverage: Coverage;
  segments: Segment[];
  comparison: Comparison | null;
  annotations: Annotation[];
  accounts: string[];
  issues: { code: string; count: number }[];
  query: DashboardQuery;
}
export type DashboardResponse = DashboardStatus & DashboardDetails;
export type DashboardState = DashboardStatus &
  Partial<DashboardDetails> & { detailsDelayed?: boolean };

export type ActionResponse =
  | DashboardStatus
  | {
      version?: undefined;
      message?: string;
      error?: string;
      operation?: OperationState;
    };
