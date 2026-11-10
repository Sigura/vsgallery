const MAX_LINES = 300;

/**
 * On-screen log of host and gallery events, enabled by loraDataset.debug. Starts collapsed
 * and expands by itself when an error is reported.
 */
export class DebugPanel {
  private readonly root: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly errorsEl: HTMLElement;
  private readonly started = performance.now();
  private errors = 0;

  constructor(private readonly state: () => string) {
    this.root = document.createElement('div');
    this.root.className = 'debug-panel collapsed';
    this.root.innerHTML = `<div class="debug-head"><strong>Debug</strong><span class="debug-errors" hidden></span><span class="spacer"></span><button type="button" data-act="copy">Copy</button><button type="button" data-act="toggle">Show</button></div><pre class="debug-state"></pre><pre class="debug-log"></pre>`;
    document.body.appendChild(this.root);
    this.stateEl = this.root.querySelector('.debug-state')!;
    this.logEl = this.root.querySelector('.debug-log')!;
    this.errorsEl = this.root.querySelector('.debug-errors')!;
    this.toggleBtn = this.root.querySelector('[data-act=toggle]')!;
    this.toggleBtn.addEventListener('click', () => this.show(this.root.classList.contains('collapsed'), false));
    this.root.querySelector('[data-act=copy]')!.addEventListener('click', () => {
      this.refresh();
      void navigator.clipboard.writeText(`${this.stateEl.textContent}\n\n${this.logEl.textContent}`);
    });
    setInterval(() => this.refresh(), 1000);
  }

  log(line: string, source = 'web'): void {
    const t = ((performance.now() - this.started) / 1000).toFixed(2).padStart(7);
    this.logEl.textContent += `${t} ${source} ${line}\n`;
    const lines = this.logEl.textContent!.split('\n');
    if (lines.length > MAX_LINES) this.logEl.textContent = lines.slice(-MAX_LINES).join('\n');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  error(line: string, source = 'web'): void {
    this.log(`ERROR ${line}`, source);
    this.show(true);
  }

  /** `fromError`: counts the error in the header. */
  show(open: boolean, fromError = open): void {
    if (fromError) {
      this.errors++;
      this.errorsEl.hidden = false;
      this.errorsEl.textContent = `${this.errors} error(s)`;
    }
    this.root.classList.toggle('collapsed', !open);
    this.toggleBtn.textContent = open ? 'Hide' : 'Show';
    if (open) {
      this.refresh();
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  refresh(): void {
    try {
      this.stateEl.textContent = this.state();
    } catch (e) {
      this.stateEl.textContent = `state failed: ${e}`;
    }
  }
}
