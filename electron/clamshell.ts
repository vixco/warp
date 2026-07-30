import { execFile } from 'child_process';

export function parseClamshellState(output: string): boolean | null {
  const matches = [...String(output).matchAll(/"AppleClamshellState"\s*=\s*(Yes|No)/gi)];
  if (!matches.length) return null;
  return matches.some((match) => match[1].toLowerCase() === 'yes');
}

export class ClamshellMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private current = false;

  constructor(private onChange: (closed: boolean) => void) {}

  get closed(): boolean {
    return process.platform === 'darwin' && this.current;
  }

  start() {
    if (process.platform !== 'darwin' || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 1000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh() {
    if (this.checking || process.platform !== 'darwin') return;
    this.checking = true;
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'],
          { timeout: 1500, maxBuffer: 256 * 1024 },
          (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const next = parseClamshellState(output);
      if (next !== null && next !== this.current) {
        this.current = next;
        this.onChange(next);
      }
    } catch {
      // Keep the last known state. A transient ioreg failure must not make an
      // internal panel reappear in the middle of a lid-closed session.
    } finally {
      this.checking = false;
    }
  }
}
