export interface LocalMonitorRef {
  label: string;
  w: number;
  h: number;
  x: number;
  y: number;
  primary: boolean;
}

export interface RemoteDisplayRef {
  id: number;
  label: string;
  width: number;
  height: number;
  primary: boolean;
  virtual: boolean;
  internal?: boolean;
  refreshRate?: number;
  x?: number;
  y?: number;
}

export interface SavedSlot {
  mon: LocalMonitorRef;
  kind: 'host' | 'new' | 'none';
  host?: RemoteDisplayRef;
  res: string;
  fps: string;
}

export interface SavedMapping {
  version: 2;
  slots: SavedSlot[];
}

export interface ResolvedSlot {
  choice: string;
  res: string;
  fps: string;
  missingHost: boolean;
}

export function localMonitorRef(mon: any): LocalMonitorRef {
  return {
    label: String(mon.label || ''),
    w: Number(mon.width) || 0,
    h: Number(mon.height) || 0,
    x: Number(mon.bounds?.x) || 0,
    y: Number(mon.bounds?.y) || 0,
    primary: !!mon.primary,
  };
}

export function scoreLocalMonitor(a: LocalMonitorRef, b: LocalMonitorRef): number {
  let score = 0;
  if (a.label && a.label === b.label) score += 3;
  if (a.w === b.w && a.h === b.h) score += 3;
  if (a.x === b.x && a.y === b.y) score += 2;
  if (a.primary === b.primary) score += 1;
  return score;
}

export function scoreRemoteDisplay(ref: RemoteDisplayRef, display: RemoteDisplayRef): number {
  const refInternal = ref.internal ??
    (/built-?in|color lcd|liquid retina/i.test(ref.label || '') ? true : undefined);
  const displayInternal = display.internal ??
    (/built-?in|color lcd|liquid retina/i.test(display.label || '') ? true : undefined);
  // An internal panel can never become an external monitor (or vice versa).
  // Treating equal resolution as enough here caused the remaining externals to
  // shift into the MacBook panel's saved slot when the lid closed.
  if (refInternal !== undefined && displayInternal !== undefined &&
      refInternal !== displayInternal) return 0;
  let score = 0;
  // Raw CG display IDs are only a weak hint because macOS can renumber/reuse
  // them across boots. Stable label/size/internal/position identity dominates.
  if (ref.id === display.id) score += 2;
  if (ref.label && ref.label === display.label) score += 5;
  if (ref.width === display.width && ref.height === display.height) score += 3;
  if (refInternal !== undefined && displayInternal !== undefined) score += 3;
  if (ref.x !== undefined && ref.y !== undefined &&
      display.x !== undefined && display.y !== undefined &&
      ref.x === display.x && ref.y === display.y) score += 2;
  if (ref.primary === display.primary) score += 1;
  if (ref.refreshRate && display.refreshRate && ref.refreshRate === display.refreshRate) score += 1;
  return score;
}

function resolveRemoteChoice(
  slot: SavedSlot,
  displays: RemoteDisplayRef[],
  used: Set<number>,
): { choice: string; missingHost: boolean } {
  if (slot.kind === 'new') return { choice: 'new', missingHost: false };
  if (slot.kind === 'none' || !slot.host) return { choice: 'none', missingHost: false };

  let best: RemoteDisplayRef | null = null;
  let bestScore = 0;
  for (const display of displays) {
    if (used.has(display.id)) continue;
    const score = scoreRemoteDisplay(slot.host, display);
    if (score > bestScore) {
      best = display;
      bestScore = score;
    }
  }

  if (best && bestScore >= 3) {
    used.add(best.id);
    return { choice: String(best.id), missingHost: false };
  }

  if (slot.host.virtual) return { choice: 'new', missingHost: false };
  return { choice: 'none', missingHost: true };
}

// Resolve saved slots one-to-one against the monitors that are connected now.
// A partial result is deliberately exposed to the caller: auto-connect must only
// proceed when every current local monitor matched a saved slot. Otherwise a
// docking/layout change would silently open just the one monitor that happened
// to match and make the remaining screens look broken.
export function resolveSavedMapping(
  saved: SavedMapping,
  localMonitors: any[],
  remoteDisplays: RemoteDisplayRef[],
): Map<number, ResolvedSlot> {
  const out = new Map<number, ResolvedSlot>();
  const pairs: { monitorIndex: number; slotIndex: number; score: number }[] = [];

  localMonitors.forEach((monitor, monitorIndex) => {
    const current = localMonitorRef(monitor);
    saved.slots.forEach((slot, slotIndex) => {
      const score = scoreLocalMonitor(current, slot.mon);
      if (score >= 3) pairs.push({ monitorIndex, slotIndex, score });
    });
  });

  pairs.sort((a, b) => b.score - a.score);
  const usedMonitors = new Set<number>();
  const usedSlots = new Set<number>();
  const usedDisplays = new Set<number>();

  for (const pair of pairs) {
    if (usedMonitors.has(pair.monitorIndex) || usedSlots.has(pair.slotIndex)) continue;
    usedMonitors.add(pair.monitorIndex);
    usedSlots.add(pair.slotIndex);
    const slot = saved.slots[pair.slotIndex];
    const remote = resolveRemoteChoice(slot, remoteDisplays, usedDisplays);
    out.set(pair.monitorIndex, {
      choice: remote.choice,
      missingHost: remote.missingHost,
      res: slot.res || 'auto',
      fps: slot.fps || '60',
    });
  }

  return out;
}
