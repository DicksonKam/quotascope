import { dayKey } from '../shared/time.ts';
import type { Annotation, Observation, Rate, Segment, TokenEvent } from '../shared/types.ts';
export function reconstruct(observations: Observation[], maxGapMs = 6 * 3600000): Segment[] {
  const groups = new Map<string, Observation[]>();
  for (const o of observations) { const key = JSON.stringify([o.account, o.bucket, o.slot, o.source]); let group=groups.get(key);if(!group){group=[];groups.set(key,group);}group.push(o); }
  const segments: Segment[] = [];
  for (const values of groups.values()) {
    let segment: Segment | undefined; let previous: Observation | undefined;
    for (const o of values.sort((a, b) => a.at - b.at)) {
      let reason = 'first-observation';
      if (previous) {
        reason = o.continuity !== previous.continuity ? 'identity-or-observation-break' : o.plan !== previous.plan ? 'plan-change' : o.duration !== previous.duration ? 'duration-change' : (o.reset === null) !== (previous.reset === null) || o.reset !== null && previous.reset !== null && Math.abs(o.reset - previous.reset) > 60 ? 'reset-deadline-shift' : o.used < previous.used ? 'usage-counter-drop' : o.at - previous.at > maxGapMs ? 'observation-gap' : '';
      }
      if (!segment || reason) {
        segment = { account: o.account, bucket: o.bucket, slot: o.slot, start: o.at, end: o.at, reset: o.reset, plan: o.plan, duration: o.duration, min: o.used, max: o.used, samples: 0, source: o.source, reason };
        segments.push(segment);
      }
      segment.end = o.at; segment.min = Math.min(segment.min, o.used); segment.max = Math.max(segment.max, o.used); segment.samples++; previous = o;
    }
  }
  return segments.sort((a, b) => b.start - a.start);
}
export function burnRate(observations: Observation[], now = Date.now()): Rate {
  const missing = (reason: string, samples = 0, hours = 0): Rate => ({ value: null, hours, samples, reason, exhaustionHours: null });
  const last = observations.at(-1);
  if (!last) return missing('Awaiting observations');
  if (last.at - now > 60000) return missing('Latest observation is in the future');
  if (now - last.at > 120000) return missing('Latest observation is stale');
  const segment = reconstruct(observations).find(s => s.account === last.account && s.bucket === last.bucket && s.slot === last.slot && s.source === last.source);
  const candidates = observations.filter(o => o.account === last.account && o.bucket === last.bucket && o.slot === last.slot && o.source === last.source && o.at >= Math.max(segment?.start ?? last.at, last.at - 6 * 3600000));
  const first = candidates[0]; const hours = first ? (last.at - first.at) / 3600000 : 0;
  if (candidates.length < 3 || hours < 1 / 60) return missing('Need at least three observations over a minute', candidates.length, hours);
  const delta = last.used - first.used;
  if (delta < 2) return missing('Rounded percentages have not moved enough', candidates.length, hours);
  const value = delta / hours;
  return { value, hours, samples: candidates.length, reason: 'Observed percentage points per wall-clock hour; rounding and metering delay apply', exhaustionHours: last.reset && (100 - last.used) / value > (last.reset * 1000 - now) / 3600000 ? null : (100 - last.used) / value };
}
export const trusted = (e: TokenEvent) => e.kind === 'response' && !e.flags.some(f => ['inconsistent-total', 'invalid-nested-counters', 'cache-write-semantics-unverified','response-id-conflict'].includes(f));
export function summarize(events: TokenEvent[], timezone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const canonical = events.filter(trusted), excluded = events.filter(e=>e.kind==='response'&&!trusted(e)).length;
  const responseThreads = new Set(events.filter(e=>e.kind==='response').map(e=>e.account+':'+e.thread));
  const fallback = events.filter(e=>e.kind==='fallback'&&!responseThreads.has(e.account+':'+e.thread)&&e.flags.every(f=>f==='cumulative-estimate'));
  const sum = (es: TokenEvent[]) => es.reduce((a, e) => ({ input: a.input + e.input, cached: a.cached + e.cached, output: a.output + e.output, reasoning: a.reasoning + e.reasoning, total: a.total + e.input + e.output, responses: a.responses + 1 }), { input: 0, cached: 0, output: 0, reasoning: 0, total: 0, responses: 0 });
  const group = (fn: (e: TokenEvent) => string) => {
    const groups = new Map<string, TokenEvent[]>(); for (const e of canonical) { const k = fn(e);let group=groups.get(k);if(!group){group=[];groups.set(k,group);}group.push(e); }
    return [...groups].map(([name, es]) => ({ name, ...sum(es), first: es[0].at, last: es.at(-1)!.at, models: [...new Set(es.map(e => e.model))], system: es.some(e => /auto-review/.test(e.model)) })).sort((a, b) => b.total - a.total);
  };
  const days = group(e => dayKey(e.at, timezone)).sort((a,b) => a.name.localeCompare(b.name));
  const latest = canonical.at(-1)?.at ?? Date.now(); const recent = canonical.filter(e => e.at > Date.now() - 3600000);
  return { ...sum(canonical), excluded, fallbackTokens:sum(fallback).total, fallbackRecords:fallback.length, first: canonical[0]?.at ?? null, last: latest, byModel: group(e => e.model), bySettings: group(e=>`${e.model} · ${e.effort} effort · ${e.speed} speed`), sessions: group(e => e.thread).slice(0, 40), days, recentTokensPerMinute: recent.length ? sum(recent).total / 60 : 0 };
}
export function comparisons(observations: Observation[], events: TokenEvent[], annotations: Annotation[]) {
  const responseThreads=new Set(events.filter(e=>e.kind==='response').map(e=>e.account+':'+e.thread));
  events=events.filter(e=>e.kind==='response'||!responseThreads.has(e.account+':'+e.thread));
  const rejected: Record<string, number> = {}; const reject = (reason: string) => { rejected[reason] = (rejected[reason] ?? 0) + 1; };
  const eligible: { account: string; bucket: string; slot: string; duration: number; providerPlan: string; plan: string; model: string; effort: string; speed: string; cacheBin: number; ratio: number; window: string; start: number; end: number }[] = [];
  const knownWindows: { account: string; bucket: string; slot: string; reset: number; id: string }[] = [];
  for (const s of reconstruct(observations.filter(s=>s.source==='account'&&s.identity!=='unknown'&&!s.account.startsWith('unattributed')), 120000).sort((a,b)=>a.start-b.start)) {
    if(new Set(observations.filter(o=>o.account===s.account&&o.source==='account').map(o=>o.bucket)).size>1){reject('Token-to-bucket attribution unavailable for multiple metered buckets');continue;}
    if (s.max - s.min < 5 || s.end - s.start < 5 * 60000) { reject('Insufficient percentage movement or duration'); continue; }
    if (s.duration === null || s.duration <= 0 || s.reset === null || s.reset * 1000 <= s.end || !s.plan) { reject('Known, unexpired window and provider plan required'); continue; }
    if (annotations.some(a => a.account === s.account && a.at > s.start && a.at <= s.end && (a.kind === 'reset' || a.kind === 'plan'))) { reject('Interval crosses a user-noted reset or plan boundary'); continue; }
    const plan = annotations.find(a => a.kind === 'plan' && a.verified && a.account === s.account && a.at <= s.start && (a.end ?? 0) >= s.end);
    const coverage = annotations.find(a => a.kind === 'coverage' && a.verified && a.account === s.account && a.at <= s.start && (a.end ?? 0) >= s.end);
    if (!plan || !coverage) { reject('Verified plan period and user-confirmed device coverage required'); continue; }
    const es = events.filter(e => e.account === s.account && e.at > s.start && e.at <= s.end);
    if (!es.length || es.some(e => !trusted(e) || /auto-review/.test(e.model))) { reject('Missing, ambiguous, or unverified system activity'); continue; }
    const cohorts = new Set(es.map(e => [e.model, e.effort, e.speed].join(':')));
    if (cohorts.size !== 1 || es.some(e => [e.model, e.effort, e.speed].includes('unknown'))) { reject('Mixed or unknown model settings'); continue; }
    if(es.some(e=>e.turnStart==null||e.turnStart<s.start||e.at-s.start<60000||s.end-e.at<60000)){reject('Response timing may cross an interval boundary or metering margin');continue;}
    const tokens = es.reduce((n, e) => n + e.input + e.output, 0);
    if (!Number.isFinite(tokens) || tokens <= 0) { reject('Positive reconciled local token activity required'); continue; }
    const input = es.reduce((n,e) => n+e.input,0), cached = es.reduce((n,e) => n+e.cached,0);
    let window = knownWindows.find(w=>w.account===s.account&&w.bucket===s.bucket&&w.slot===s.slot&&Math.abs(w.reset-s.reset!)<=60);
    if (!window) { window={account:s.account,bucket:s.bucket,slot:s.slot,reset:s.reset,id:`window-${knownWindows.length}`};knownWindows.push(window); }
    eligible.push({ account: s.account, bucket: s.bucket, slot: s.slot, duration: s.duration, providerPlan: s.plan, plan: plan.label, model: es[0].model, effort: es[0].effort, speed: es[0].speed, cacheBin: Math.floor(10 * cached / Math.max(1, input)), ratio: tokens / (s.max-s.min), window: window.id, start: s.start, end: s.end });
  }
  const groups = new Map<string, typeof eligible>();
  for (const row of eligible) { const key = JSON.stringify([row.account, row.bucket, row.slot, row.duration, row.providerPlan, row.plan, row.model, row.effort, row.speed, row.cacheBin]); groups.set(key, [...(groups.get(key) ?? []), row]); }
  const cohorts = [...groups.values()].map(rows => {
    const values = rows.map(r => r.ratio).sort((a,b) => a-b), windows = new Set(rows.map(r => r.window)).size;
    return { ...rows[0], start: rows[0].start, end: rows.reduce((end, r) => Math.max(end, r.end), rows[0].end), min: values[0], max: values.at(-1)!, median: values[Math.floor(values.length/2)], intervals: rows.length, windows, qualified: windows >= 3 };
  });
  const pairs: { before: string; after: string; ratio: number; model: string }[] = [];
  for (let i=0;i<cohorts.length;i++) for (let j=i+1;j<cohorts.length;j++) {
    const a=cohorts[i],b=cohorts[j];
    if (a.qualified && b.qualified && a.account === b.account && a.bucket === b.bucket && a.slot === b.slot && a.duration === b.duration && a.plan !== b.plan && a.end < b.start && a.model===b.model && a.effort===b.effort && a.speed===b.speed && a.cacheBin===b.cacheBin) pairs.push({before:a.plan,after:b.plan,ratio:b.median/a.median,model:a.model});
  }
  return { cohorts, pairs, rejected, status: pairs.length ? 'Descriptive matched comparison' : 'Insufficient evidence', caveat: 'User-confirmed coverage is an assumption; other devices, cloud tasks and Work may be missing. Ratios describe local tokens per account-wide percentage point, not cost or productivity. Unchanged rounded percentages do not mean free usage. Matching cache bands can hide gains from increased caching; workload and provider rollout timing are not verified. No fixed token quota or causal improvement is inferred.' };
}
// Pace is a diagnostic, not a forecast. Sparse history cannot support an hourly rate.
export function conservativePace(observations:Observation[],now=Date.now()):Rate {
 const rate=burnRate(observations,now);
 const missing=(reason:string):Rate=>({...rate,value:null,reason,exhaustionHours:null});
 if(rate.value===null)return missing(rate.reason);
 const last=observations.at(-1)!;
 const points=observations.filter(o=>o.source==='account'&&o.account===last.account&&o.bucket===last.bucket&&o.slot===last.slot&&o.at>=last.at-rate.hours*3600000-1);
 if(last.source!=='account'||rate.hours<.25||points.length<15)return missing('Need at least 15 direct readings spanning 15 minutes');
 if(points.some((o,i)=>i>0&&o.at-points[i-1].at>120000))return missing('Recent readings include a monitoring gap');
 if(last.used-points[0].used<3)return missing('Rounded percentages have not moved enough');
 return {...rate,exhaustionHours:null};
}
