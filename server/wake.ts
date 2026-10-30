/**
 * Node's timers stop while the Mac sleeps, because libuv's clock does not advance during sleep. A retry
 * scheduled before the lid closed can therefore still be minutes away after waking. This heartbeat compares
 * the wall clock between beats: a jump much larger than one beat means the process was asleep (or stalled),
 * so the caller can read straight away instead of waiting out the old schedule.
 */
export function watchForWake(
  onWake: () => void,
  {
    beatMs = 10000,
    slackMs = 30000,
    now = Date.now,
  }: { beatMs?: number; slackMs?: number; now?: () => number } = {},
): () => void {
  let last = now();
  const timer = setInterval(() => {
    const current = now();
    if (current - last > beatMs + slackMs) onWake();
    last = current;
  }, beatMs);
  timer.unref();
  return () => clearInterval(timer);
}
