export type Source = "account" | "local" | "manual";
export interface Observation {
  id?: number;
  account: string;
  bucket: string;
  slot: "primary" | "secondary";
  at: number;
  used: number;
  duration: number | null;
  reset: number | null;
  plan: string | null;
  source: Source;
  resetCredits: number | null;
  balance: string | null;
  identity?: "provider" | "unknown";
  continuity?: string;
}
export interface AccountSnapshot {
  id: string;
  at: number;
  account: string;
  identity: "provider" | "unknown";
  continuity: string;
  windows: Observation[];
}
export interface Usage {
  input: number;
  cached: number;
  cacheWrite: number | null;
  output: number;
  reasoning: number;
  total: number;
}
export interface TokenEvent extends Usage {
  key: string;
  account: string;
  device: string;
  thread: string;
  session: string;
  at: number;
  model: string;
  effort: string;
  speed: string;
  kind: "response" | "fallback";
  flags: string[];
  turnStart?: number | null;
}
export interface Annotation {
  id?: number;
  kind: "plan" | "reset" | "coverage";
  at: number;
  end: number | null;
  account: string;
  label: string;
  verified: boolean;
}
export interface Attempt {
  at: number;
  ok: boolean;
  message: string;
}
export interface Segment {
  duration: number | null;
  account: string;
  bucket: string;
  slot: string;
  start: number;
  end: number;
  reset: number | null;
  plan: string | null;
  min: number;
  max: number;
  samples: number;
  source: Source;
  reason: string;
}
export interface Rate {
  value: number | null;
  hours: number;
  samples: number;
  reason: string;
  exhaustionHours: number | null;
}
