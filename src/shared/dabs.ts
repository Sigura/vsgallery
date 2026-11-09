export interface DabPoint {
  x: number;
  y: number;
  pressure: number;
}

/**
 * Positions of brush dabs along a stroke: one every `step(pressure)` pixels, with the remainder
 * carried over between segments so spacing stays even however the pointer samples arrive.
 */
export class DabSpacer {
  private last: DabPoint | undefined;
  /** Distance travelled since the last dab. */
  private carry = 0;

  constructor(private readonly step: (pressure: number) => number) {}

  get lastPoint(): DabPoint | undefined {
    return this.last;
  }

  begin(p: DabPoint): DabPoint[] {
    this.last = p;
    this.carry = 0;
    return [p];
  }

  to(p: DabPoint): DabPoint[] {
    const from = this.last;
    if (!from) return this.begin(p);
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (!dist) return [];
    const out: DabPoint[] = [];
    // Positions are distances along this segment; the previous dab lies `carry` before its start.
    let lastPos = -this.carry;
    let t = lastPos + this.step(from.pressure);
    while (t <= dist) {
      const k = t / dist;
      const q = { x: from.x + dx * k, y: from.y + dy * k, pressure: from.pressure + (p.pressure - from.pressure) * k };
      out.push(q);
      lastPos = t;
      t = lastPos + this.step(q.pressure);
    }
    this.carry = dist - lastPos;
    this.last = p;
    return out;
  }
}
