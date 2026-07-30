export interface DisplayLike {
  id: number;
  internal?: boolean;
  detected?: boolean;
}

export interface CaptureSourceLike {
  display_id: string;
}

// Electron/Chromium can expose the same CGDirectDisplayID once as a signed
// 32-bit number and once as an unsigned decimal string. Compare the raw 32-bit
// identity so a valid secondary display never misses and falls onto screen 1.
export function normalizedDisplayId(value: string | number): number | null {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.trunc(number) >>> 0;
}

export function displayIdsEqual(a: string | number, b: string | number): boolean {
  const left = normalizedDisplayId(a);
  const right = normalizedDisplayId(b);
  return left !== null && right !== null && left === right;
}

export function connectedDisplays<T extends DisplayLike>(
  displays: T[],
  lidClosed: boolean,
  isMac: boolean,
): T[] {
  return displays.filter((display) =>
    display.detected !== false && !(isMac && lidClosed && display.internal === true));
}

export function findDisplayById<T extends DisplayLike>(
  displays: T[],
  displayId: string | number,
): T | undefined {
  return displays.find((display) => displayIdsEqual(display.id, displayId));
}

export function findCaptureSource<T extends CaptureSourceLike>(
  sources: T[],
  displayId: string | number,
): T | undefined {
  return sources.find((source) => displayIdsEqual(source.display_id, displayId));
}

export async function waitForCaptureTarget<
  TSource extends CaptureSourceLike,
  TDisplay extends DisplayLike,
>(
  loadSources: () => Promise<TSource[]>,
  loadDisplays: () => TDisplay[],
  displayId: string | number,
  attempts = 12,
  delayMs = 150,
  wait: (ms: number) => Promise<void> =
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ source: TSource; display: TDisplay } | null> {
  const tries = Math.max(1, attempts);
  for (let attempt = 0; attempt < tries; attempt++) {
    const [sources, displays] = await Promise.all([
      loadSources(),
      Promise.resolve(loadDisplays()),
    ]);
    const source = findCaptureSource(sources, displayId);
    const display = findDisplayById(displays, displayId);
    if (source && display) return { source, display };
    if (attempt + 1 < tries) await wait(delayMs);
  }
  return null;
}
