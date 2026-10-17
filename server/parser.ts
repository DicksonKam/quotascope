import type { Observation, TokenEvent, Usage } from '../shared/types.ts';
import { label, numeric } from './privacy.ts';
import type { Store } from './store.ts';
export interface Context {
  account: string; device: string; thread: string; session: string; model: string; effort: string;
  speed: string; parent: boolean; previous?: Usage; turnStart?: number; offset: number; inode: string; modified: number; parser: number;
}
export function usage(v: any): Usage | null {
  if (!v || typeof v !== 'object') return null;
  const values = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].map(k => numeric(v[k]));
  if (values.some(n => n === null || n < 0 || !Number.isSafeInteger(n))) return null;
  const [input, cached, output, reasoning, total] = values as number[];
  const cacheWrite = v.cache_write_input_tokens == null ? null : numeric(v.cache_write_input_tokens);
  if (v.cache_write_input_tokens != null && (cacheWrite === null || cacheWrite < 0 || !Number.isSafeInteger(cacheWrite))) return null;
  return { input, cached, cacheWrite, output, reasoning, total };
}
export function usageFlags(u: Usage) {
  const f: string[] = [];
  if (u.total !== u.input + u.output) f.push('inconsistent-total');
  if (u.cached > u.input || u.reasoning > u.output) f.push('invalid-nested-counters');
  if (u.cacheWrite) f.push('cache-write-semantics-unverified');
  return f;
}
export function parseRecord(d: any, ctx: Context, store: Store, hash: (v: unknown) => string, fileKey: string, offset: number) {
  const v = d?.payload;
  if (!v || typeof v !== 'object') return;
  const at = Date.parse(d.timestamp ?? '');
  const issue = (code: string) => store.issue(`${fileKey}:${offset}:${code}`, code);
  if (d.type === 'session_meta') {
    ctx.account = v.creator_account_id ? hash(v.creator_account_id) : ctx.account;
    ctx.thread = hash(v.id ?? v.thread_id ?? fileKey); ctx.session = hash(v.session_id ?? v.id ?? fileKey);
    ctx.parent = Boolean(v.parent_thread_id || v.history_base);
    if (ctx.parent) issue('inherited-history');
  } else if (d.type === 'turn_context') {
    ctx.model = label(v.model); ctx.effort = label(v.effort ?? v.reasoning_effort);
    ctx.speed = label(v.service_tier ?? v.speed);
    if (Number.isFinite(at) && ctx.turnStart === undefined) ctx.turnStart=at;
  } else if (d.type === 'event_msg' && v.type === 'task_started') {
    ctx.turnStart=Number.isFinite(at)?at:undefined;
  } else if (d.type === 'event_msg' && v.type === 'task_complete') {
    ctx.turnStart=undefined;
  } else if (d.type === 'token_usage_record') {
    const u = usage(v.usage);
    if (!u || !Number.isFinite(at) || typeof v.response_id !== 'string') { issue('unusable-response'); return; }
    const flags = usageFlags(u);
    flags.forEach(issue);
    if (ctx.account === 'unattributed-local') flags.push('account-unknown');
    const thread = v.thread_id ? hash(v.thread_id) : ctx.thread;
    const e: TokenEvent = { ...u, key: hash([ctx.account, v.response_id].join(':')), account: ctx.account, device: ctx.device, thread, session: ctx.session, at, model: ctx.model, effort: ctx.effort, speed: ctx.speed, kind: 'response', flags, turnStart:ctx.turnStart??null };
    store.event(e);
  } else if (d.type === 'event_msg' && v.type === 'token_count') {
    const total = usage(v.info?.total_token_usage);
    if (total) {
      usageFlags(total).forEach(issue);
      if (ctx.previous && JSON.stringify(total) === JSON.stringify(ctx.previous)) issue('repeated-cumulative');
      if (ctx.previous && total.total < ctx.previous.total) issue('counter-discontinuity');
      // Normalize only the legacy identity key to retain pre-null replay identity.
      // The stored counter remains null when unreported.
      // Keep marked deltas for legacy-only threads. Never add them to response records.
      const last = usage(v.info?.last_token_usage);
      const baseline = ctx.previous ?? (last && last.total===total.total && !ctx.parent ? {input:0,cached:0,cacheWrite:0,output:0,reasoning:0,total:0} : null);
      if (baseline && Number.isFinite(at) && total.total > baseline.total) {
        const delta = Object.fromEntries(Object.keys(total).map(k=>[k,(total as any)[k] == null || (baseline as any)[k] == null ? null : (total as any)[k]-(baseline as any)[k]])) as unknown as Usage;
        if (Object.values(delta).every(n=>n===null||n>=0)) store.event({...delta,key:hash([ctx.account,ctx.thread,'cumulative',JSON.stringify({...total,cacheWrite:total.cacheWrite??0})].join(':')),account:ctx.account,device:ctx.device,thread:ctx.thread,session:ctx.session,at,model:ctx.model,effort:ctx.effort,speed:ctx.speed,kind:'fallback',flags:['cumulative-estimate',...usageFlags(delta)]});
      } else if (!baseline) issue('unresolved-inherited-baseline');
      ctx.previous = total;
    }
    if (!Number.isFinite(at)) return;
    const rate = v.rate_limits;
    if (!rate || typeof rate !== 'object') return;
    for (const slot of ['primary', 'secondary'] as const) {
      const w = rate[slot], used = numeric(w?.used_percent);
      if (used === null || used < 0 || used > 100) continue;
      const o: Observation = { account: ctx.account, bucket: label(rate.limit_id ?? 'codex'), slot, at, used, duration: numeric(w.window_minutes), reset: numeric(w.resets_at), plan: rate.plan_type ? label(rate.plan_type) : null, source: 'local', resetCredits: null, balance: null };
      store.observe(o);
    }
  }
}
