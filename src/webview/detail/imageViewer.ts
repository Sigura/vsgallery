const MIN_SCALE = 0.02;
const MAX_SCALE = 64;
const GRID_MIN_SCALE = 10;

export type ViewerSource = ImageBitmap | HTMLImageElement | OffscreenCanvas | HTMLCanvasElement;

export interface ImagePoint {
  x: number;
  y: number;
  pressure: number;
}

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

/** An editing tool receives left-button input in image coordinates. */
export interface ViewerTool {
  cursor: string;
  down(e: PointerEvent, p: ImagePoint): void;
  /** `points`: coalesced samples since the last event, for smooth strokes. */
  move(e: PointerEvent, points: ImagePoint[]): void;
  up(e: PointerEvent, p: ImagePoint): void;
  /** Pointer position while not pressed (undefined when it leaves the view). */
  hover?(p: ImagePoint | undefined): void;
}

/** Canvas image view with zoom toward the cursor, panning and a pixel grid at high zoom. */
export class ImageViewer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private image: ViewerSource | undefined;
  private imgW = 0;
  private imgH = 0;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  /** While true, the view re-fits on resize and on new images. */
  private fitted = true;
  private checker: CanvasPattern | null = null;
  private frame = 0;
  private pan: { id: number; x: number; y: number } | undefined;
  private spaceHeld = false;
  private message = '';
  private toolActive: number | undefined;
  private currentTool: ViewerTool | undefined;
  onZoom: (scale: number) => void = () => {};
  /** Drawn on top of the image in screen (CSS pixel) coordinates. */
  overlay: ((ctx: CanvasRenderingContext2D, view: ViewTransform) => void) | undefined;

  constructor(private readonly host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewer-canvas';
    this.canvas.tabIndex = 0;
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.endPan(e));
    this.canvas.addEventListener('pointercancel', (e) => this.endPan(e));
    this.canvas.addEventListener('auxclick', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerleave', () => {
      if (this.toolActive === undefined) this.currentTool?.hover?.(undefined);
    });
    window.addEventListener('keydown', (e) => {
      // offsetParent is null while the detail view is hidden.
      if (e.key === ' ' && !isTyping(e.target) && this.host.offsetParent !== null) {
        this.spaceHeld = true;
        this.refreshCursor();
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') {
        this.spaceHeld = false;
        this.refreshCursor();
      }
    });
  }

  get zoom(): number {
    return this.scale;
  }

  get view(): ViewTransform {
    return { scale: this.scale, tx: this.tx, ty: this.ty };
  }

  get tool(): ViewerTool | undefined {
    return this.currentTool;
  }

  set tool(t: ViewerTool | undefined) {
    this.currentTool = t;
    this.refreshCursor();
  }

  requestDraw(): void {
    this.schedule();
  }

  toImage(clientX: number, clientY: number, pressure = 1): ImagePoint {
    const r = this.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - this.tx) / this.scale, y: (clientY - r.top - this.ty) / this.scale, pressure };
  }

  /**
   * Shows `img` drawn at w×h image pixels (a thumbnail can stand in for the original).
   * `keepView` keeps zoom/pan when the size is unchanged, e.g. when the original replaces its preview.
   */
  setImage(img: ViewerSource | undefined, w = 0, h = 0, keepView = false): void {
    this.image = img;
    this.message = '';
    const sameSize = w === this.imgW && h === this.imgH;
    this.imgW = w;
    this.imgH = h;
    if (!keepView || !sameSize || this.fitted) this.fit();
    else this.schedule();
  }

  showMessage(text: string): void {
    this.image = undefined;
    this.message = text;
    this.schedule();
  }

  fit(): void {
    this.fitted = true;
    const { width, height } = this.viewSize();
    if (!this.imgW || !width) {
      this.schedule();
      return;
    }
    this.scale = Math.min(width / this.imgW, height / this.imgH);
    this.center();
  }

  actualSize(): void {
    this.fitted = false;
    this.scale = 1;
    this.center();
  }

  zoomBy(factor: number, cx?: number, cy?: number): void {
    const { width, height } = this.viewSize();
    this.zoomAt(this.scale * factor, cx ?? width / 2, cy ?? height / 2);
  }

  private zoomAt(next: number, cx: number, cy: number): void {
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    // Keep the image point under (cx, cy) fixed.
    this.tx = cx - ((cx - this.tx) * s) / this.scale;
    this.ty = cy - ((cy - this.ty) * s) / this.scale;
    this.scale = s;
    this.fitted = false;
    this.onZoom(s);
    this.schedule();
  }

  private center(): void {
    const { width, height } = this.viewSize();
    this.tx = (width - this.imgW * this.scale) / 2;
    this.ty = (height - this.imgH * this.scale) / 2;
    this.onZoom(this.scale);
    this.schedule();
  }

  private viewSize(): { width: number; height: number } {
    return { width: this.host.clientWidth, height: this.host.clientHeight };
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = this.viewSize();
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    if (this.fitted) this.fit();
    else this.schedule();
  }

  private schedule(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  private checkerPattern(): CanvasPattern | null {
    if (this.checker) return this.checker;
    const c = new OffscreenCanvas(16, 16);
    const g = c.getContext('2d')!;
    g.fillStyle = '#cfcfcf';
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#9f9f9f';
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    this.checker = this.ctx.createPattern(c, 'repeat');
    return this.checker;
  }

  private draw(): void {
    this.frame = 0;
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { width, height } = this.viewSize();
    if (!this.image) {
      if (this.message) {
        ctx.fillStyle = getComputedStyle(this.host).color;
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(this.message, width / 2, height / 2);
      }
      return;
    }
    const w = this.imgW * this.scale;
    const h = this.imgH * this.scale;
    ctx.fillStyle = this.checkerPattern() ?? '#bbb';
    ctx.fillRect(this.tx, this.ty, w, h);
    ctx.imageSmoothingEnabled = this.scale < 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.image, this.tx, this.ty, w, h);
    if (this.scale >= GRID_MIN_SCALE) this.drawGrid(width, height);
    this.overlay?.(ctx, this.view);
  }

  private drawGrid(width: number, height: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const x0 = Math.max(0, Math.floor(-this.tx / s));
    const x1 = Math.min(this.imgW, Math.ceil((width - this.tx) / s));
    const y0 = Math.max(0, Math.floor(-this.ty / s));
    const y1 = Math.min(this.imgH, Math.ceil((height - this.ty) / s));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) {
      const px = Math.round(this.tx + x * s) + 0.5;
      ctx.moveTo(px, this.ty + y0 * s);
      ctx.lineTo(px, this.ty + y1 * s);
    }
    for (let y = y0; y <= y1; y++) {
      const py = Math.round(this.ty + y * s) + 0.5;
      ctx.moveTo(this.tx + x0 * s, py);
      ctx.lineTo(this.tx + x1 * s, py);
    }
    ctx.strokeStyle = 'rgba(128, 128, 128, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 33 : e.deltaY;
    this.zoomAt(this.scale * Math.pow(1.0015, -delta), p.x, p.y);
  }

  private onPointerDown(e: PointerEvent): void {
    this.canvas.focus({ preventScroll: true });
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    if (e.button === 0 && this.currentTool && !this.spaceHeld && this.image) {
      this.toolActive = e.pointerId;
      this.currentTool.down(e, this.toImage(e.clientX, e.clientY, pressureOf(e)));
      return;
    }
    // Middle button, Space+drag, or left drag without an editing tool pans.
    this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.refreshCursor();
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.toolActive === e.pointerId && this.currentTool) {
      const events = e.getCoalescedEvents?.() ?? [];
      const samples = events.length ? events : [e];
      this.currentTool.move(
        e,
        samples.map((s) => this.toImage(s.clientX, s.clientY, pressureOf(s))),
      );
      return;
    }
    if (!this.pan && this.toolActive === undefined) {
      this.currentTool?.hover?.(this.toImage(e.clientX, e.clientY));
      return;
    }
    if (!this.pan || this.pan.id !== e.pointerId) return;
    this.tx += e.clientX - this.pan.x;
    this.ty += e.clientY - this.pan.y;
    this.pan.x = e.clientX;
    this.pan.y = e.clientY;
    this.fitted = false;
    this.schedule();
  }

  private endPan(e: PointerEvent): void {
    if (this.toolActive === e.pointerId) {
      this.toolActive = undefined;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      this.currentTool?.up(e, this.toImage(e.clientX, e.clientY, pressureOf(e)));
      return;
    }
    if (!this.pan || this.pan.id !== e.pointerId) return;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    this.pan = undefined;
    this.refreshCursor();
  }

  refreshCursor(): void {
    this.canvas.style.cursor = this.pan ? 'grabbing' : this.spaceHeld ? 'grab' : (this.currentTool?.cursor ?? 'default');
  }
}

/** Mice report 0.5 while pressed; only pens and touch carry real pressure. */
function pressureOf(e: PointerEvent): number {
  return e.pointerType === 'pen' || e.pointerType === 'touch' ? Math.max(0.01, e.pressure) : 1;
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
