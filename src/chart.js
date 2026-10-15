const PALETTE = {
  background: '#0c1018', grid: '#1c2431', text: '#68778d', strong: '#c5cedb',
  rise: '#f05264', fall: '#4b8dff', gold: '#e6bb6c', violet: '#b1a0ff',
};

/** A dependency-free, high-DPI market chart. All prices remain in the stock's native currency. */
export class MarketChart {
  constructor(canvas, options = {}) {
    if (!canvas?.getContext) throw new TypeError('MarketChart requires a canvas element.');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = { candles: [], positions: [], stock: {}, interval: 1, chartType: 'candles', showMA: true, showVolume: true, ...options };
    this.visibleCount = 72;
    this.offset = 0;
    this.width = 0;
    this.height = 0;
    this.pointer = null;
    this.drag = null;
    this.frame = 0;
    this.destroyed = false;
    this.lastIdentity = '';
    this.canvas.style.touchAction = 'none';
    this.canvas.style.cursor = 'crosshair';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '실시간 모의 주가 차트. 휠로 확대하고 드래그하여 과거 가격을 볼 수 있습니다.');
    this.listeners = {
      pointermove: (event) => this.onPointerMove(event),
      pointerleave: () => { if (!this.drag) { this.pointer = null; this.schedule(); } },
      pointerdown: (event) => this.onPointerDown(event),
      pointerup: () => this.onPointerUp(),
      pointercancel: () => this.onPointerUp(),
      dblclick: () => this.resetView(),
      wheel: (event) => this.onWheel(event),
    };
    Object.entries(this.listeners).forEach(([name, handler]) => canvas.addEventListener(name, handler, { passive: name !== 'wheel' }));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement || canvas);
    this.resize();
  }

  update(next = {}) {
    const stock = next.stock ?? this.data.stock;
    const identity = `${stock?.id ?? stock?.ticker ?? ''}:${next.interval ?? this.data.interval}`;
    if (this.lastIdentity && identity !== this.lastIdentity) {
      this.offset = 0;
      this.pointer = null;
    }
    this.lastIdentity = identity;
    this.data = { ...this.data, ...next };
    if (!Array.isArray(this.data.candles)) this.data.candles = [];
    this.offset = Math.min(this.offset, Math.max(0, this.data.candles.length - Math.min(20, this.data.candles.length)));
    this.schedule();
  }

  resize() {
    const box = (this.canvas.parentElement || this.canvas).getBoundingClientRect();
    this.width = Math.max(0, Math.floor(box.width));
    this.height = Math.max(0, Math.floor(box.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.schedule();
  }

  schedule() {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  resetView() {
    this.offset = 0;
    this.visibleCount = 72;
    this.pointer = null;
    this.schedule();
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    Object.entries(this.listeners).forEach(([name, handler]) => this.canvas.removeEventListener(name, handler));
  }

  localPointer(event) {
    const box = this.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  onPointerDown(event) {
    if (event.button !== 0) return;
    this.pointer = this.localPointer(event);
    this.drag = { startX: this.pointer.x, startOffset: this.offset };
    this.canvas.setPointerCapture?.(event.pointerId);
    this.canvas.style.cursor = 'grabbing';
  }

  onPointerMove(event) {
    this.pointer = this.localPointer(event);
    if (this.drag && this.layout) {
      const change = Math.round((this.pointer.x - this.drag.startX) / this.layout.step);
      this.offset = Math.max(0, Math.min(this.data.candles.length - Math.min(20, this.data.candles.length), this.drag.startOffset + change));
    }
    this.schedule();
  }

  onPointerUp() {
    this.drag = null;
    this.canvas.style.cursor = 'crosshair';
    this.schedule();
  }

  onWheel(event) {
    event.preventDefault();
    const oldCount = this.visibleCount;
    this.visibleCount = Math.max(20, Math.min(180, Math.round(oldCount * (event.deltaY > 0 ? 1.13 : 0.88))));
    if (this.offset && this.layout) {
      const point = this.localPointer(event);
      const anchor = Math.max(0, Math.min(1, (point.x - this.layout.left) / this.layout.plotWidth));
      this.offset = Math.max(0, Math.min(this.data.candles.length - 20, this.offset + Math.round((oldCount - this.visibleCount) * (1 - anchor))));
    }
    this.schedule();
  }

  formatPrice(price) {
    if (!Number.isFinite(price)) return '—';
    const currency = this.data.stock?.currency || 'KRW';
    return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: currency === 'KRW' ? (Math.abs(price) < 100 ? 2 : 0) : 2, minimumFractionDigits: currency === 'KRW' ? 0 : 2 }).format(price);
  }

  formatTime(time) {
    const date = new Date(time);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  text(text, x, y, color = PALETTE.text, size = 10, align = 'left', weight = 400) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px "Inter", "Pretendard", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  line(x1, y1, x2, y2, color, width = 1, dash = []) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  roundedRect(x, y, width, height, radius, fill) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  draw() {
    const { ctx, width, height } = this;
    if (!ctx || width < 1 || height < 1) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = PALETTE.background;
    ctx.fillRect(0, 0, width, height);
    const candles = this.data.candles;
    if (!candles.length || width < 100 || height < 100) {
      this.text('시장을 연결하는 중...', width / 2, height / 2, PALETTE.text, 12, 'center');
      return;
    }

    const compact = width < 520;
    const left = compact ? 10 : 18;
    const right = compact ? 69 : 84;
    const top = compact ? 55 : 54;
    const bottom = height - 32;
    const plotWidth = Math.max(1, width - left - right);
    const plotHeight = Math.max(1, bottom - top);
    const end = Math.max(1, candles.length - this.offset);
    const start = Math.max(0, end - this.visibleCount);
    const visible = candles.slice(start, end);
    const count = visible.length;
    const slots = Math.max(count, Math.min(30, this.visibleCount));
    const step = plotWidth / (slots + 3.5);
    const volumeHeight = this.data.showVolume ? Math.min(88, plotHeight * 0.18) : 0;
    const priceBottom = bottom - volumeHeight - (volumeHeight ? 14 : 0);
    let low = Math.min(...visible.map((bar) => bar.low));
    let high = Math.max(...visible.map((bar) => bar.high));
    const range = Math.max(high - low, Math.abs(high) * 0.004, 0.01);
    high += range * 0.13;
    low -= range * 0.13;
    const y = (value) => top + (high - value) / (high - low) * Math.max(1, priceBottom - top);
    const x = (index) => left + (index + 0.65) * step;
    this.layout = { left, right, top, bottom, plotWidth, step, start, end, low, high, priceBottom };

    // Restrained exchange watermark remains behind the market data.
    ctx.save();
    ctx.globalAlpha = 0.035;
    this.text('M', left + plotWidth / 2, top + plotHeight * 0.42, '#d5e2f8', Math.min(125, plotWidth * 0.24), 'center', 800);
    ctx.globalAlpha = 0.075;
    this.text('MOCK EXCHANGE', left + plotWidth / 2, top + plotHeight * 0.42 + 66, '#bdd0ed', compact ? 10 : 12, 'center', 600);
    ctx.restore();

    const gridRows = Math.max(3, Math.min(7, Math.floor(plotHeight / 72)));
    for (let row = 0; row <= gridRows; row += 1) {
      const value = high - (high - low) * row / gridRows;
      const gridY = y(value);
      this.line(left, gridY, width - right + 2, gridY, PALETTE.grid);
      this.text(this.formatPrice(value), width - right + 14, gridY, PALETTE.text, 10);
    }
    const gridColumns = Math.max(2, Math.floor(plotWidth / 100));
    const indices = new Set();
    for (let column = 0; column < gridColumns; column += 1) {
      const index = Math.min(count - 1, Math.round(column * (count - 1) / Math.max(1, gridColumns - 1)));
      if (indices.has(index)) continue;
      indices.add(index);
      const gridX = x(index);
      this.line(gridX, top, gridX, bottom, PALETTE.grid);
      this.text(this.formatTime(visible[index].time), gridX, height - 14, PALETTE.text, 10, 'center');
    }
    this.line(width - right + 2, 0, width - right + 2, height, PALETTE.grid);
    this.line(0, bottom + 6, width, bottom + 6, PALETTE.grid);

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top - 4, plotWidth, bottom - top + 4);
    ctx.clip();
    if (this.data.showVolume) {
      const maximumVolume = Math.max(1, ...visible.map((bar) => bar.volume || 0));
      visible.forEach((bar, index) => {
        const volume = Math.max(1, (bar.volume || 0) / maximumVolume * volumeHeight);
        ctx.fillStyle = bar.close >= bar.open ? 'rgba(240, 82, 100, 0.19)' : 'rgba(75, 141, 255, 0.19)';
        ctx.fillRect(x(index) - step * 0.31, bottom - volume, Math.max(1, step * 0.62), volume);
      });
    }

    if (this.data.chartType === 'line') {
      const last = visible[count - 1];
      const color = last.close >= visible[0].close ? PALETTE.rise : PALETTE.fall;
      const gradient = ctx.createLinearGradient(0, top, 0, priceBottom);
      gradient.addColorStop(0, `${color}35`);
      gradient.addColorStop(1, `${color}00`);
      ctx.beginPath();
      visible.forEach((bar, index) => index ? ctx.lineTo(x(index), y(bar.close)) : ctx.moveTo(x(index), y(bar.close)));
      ctx.lineTo(x(count - 1), priceBottom);
      ctx.lineTo(x(0), priceBottom);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.beginPath();
      visible.forEach((bar, index) => index ? ctx.lineTo(x(index), y(bar.close)) : ctx.moveTo(x(index), y(bar.close)));
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else {
      visible.forEach((bar, index) => {
        const color = bar.close >= bar.open ? PALETTE.rise : PALETTE.fall;
        const barX = x(index);
        this.line(barX, y(bar.high), barX, y(bar.low), color, Math.max(1, Math.min(1.5, step / 6)));
        ctx.fillStyle = color;
        ctx.fillRect(barX - step * 0.31, Math.min(y(bar.open), y(bar.close)), Math.max(1.5, step * 0.62), Math.max(1.2, Math.abs(y(bar.open) - y(bar.close))));
      });
    }

    if (this.data.showMA) {
      this.drawMovingAverage(candles, start, end, 20, x, y, PALETTE.gold);
      this.drawMovingAverage(candles, start, end, 50, x, y, PALETTE.violet);
    }

    const positions = Array.isArray(this.data.positions) ? this.data.positions : [];
    positions.slice(0, 8).forEach((position) => {
      const entry = Number(position.entryPrice ?? position.entry ?? position.openPrice);
      if (!Number.isFinite(entry) || entry < low || entry > high) return;
      const entryY = y(entry);
      const color = position.direction === 'low' ? PALETTE.fall : PALETTE.rise;
      this.line(left, entryY, width - right, entryY, `${color}90`, 1, [4, 4]);
      const label = `${position.direction === 'low' ? 'LOW' : 'HIGH'}  ${this.formatPrice(entry)}`;
      ctx.font = '600 9px "Inter", sans-serif';
      const labelWidth = ctx.measureText(label).width + 16;
      this.roundedRect(left + 5, entryY - 10, labelWidth, 19, 4, '#141e2b');
      this.text(label, left + 13, entryY, color, 9, 'left', 600);
    });
    ctx.restore();

    const liveCandle = candles[candles.length - 1];
    if (!this.offset) {
      const currentY = y(liveCandle.close);
      const color = liveCandle.close >= liveCandle.open ? PALETTE.rise : PALETTE.fall;
      this.line(left, currentY, width - right + 3, currentY, `${color}b8`, 1, [4, 4]);
      ctx.beginPath();
      ctx.arc(x(count - 1), currentY, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x(count - 1), currentY, 7, 0, Math.PI * 2);
      ctx.fillStyle = `${color}24`;
      ctx.fill();
      this.roundedRect(width - right + 3, currentY - 12, right - 7, 24, 3, color);
      this.text(this.formatPrice(liveCandle.close), width - right / 2 + 1, currentY, '#ffffff', compact ? 9 : 10, 'center', 600);
    } else {
      this.roundedRect(width - right - 104, bottom - 34, 96, 24, 5, '#1a2433');
      this.text('더블클릭 · 실시간', width - right - 56, bottom - 22, '#9aacc5', 10, 'center');
    }

    let focusCandle = visible[count - 1];
    if (this.pointer && this.pointer.x >= left && this.pointer.x <= width - right && this.pointer.y >= top && this.pointer.y <= bottom) {
      const index = Math.max(0, Math.min(count - 1, Math.round((this.pointer.x - left) / step - 0.65)));
      focusCandle = visible[index];
      const crossX = x(index);
      const crossY = this.pointer.y;
      this.line(crossX, top, crossX, bottom, '#75849b80', 1, [3, 4]);
      this.line(left, crossY, width - right + 3, crossY, '#75849b80', 1, [3, 4]);
      const crossPrice = high - (crossY - top) / Math.max(1, priceBottom - top) * (high - low);
      this.roundedRect(width - right + 3, crossY - 11, right - 7, 22, 3, '#344155');
      this.text(this.formatPrice(crossPrice), width - right / 2 + 1, crossY, '#e2e8f0', compact ? 9 : 10, 'center', 500);
      const timeX = Math.max(left + 28, Math.min(width - right - 28, crossX));
      this.roundedRect(timeX - 28, height - 26, 56, 22, 3, '#344155');
      this.text(this.formatTime(focusCandle.time), timeX, height - 15, '#e2e8f0', 10, 'center');
    }

    // Metadata is painted last so moving price lines never obscure it.
    ctx.fillStyle = PALETTE.background;
    ctx.fillRect(0, 0, width - right + 1, top - 7);
    const ticker = this.data.stock?.ticker || this.data.stock?.symbol || this.data.stock?.id || 'MARKET';
    const minutes = Number(this.data.interval) || 1;
    this.text(`${ticker} · ${minutes >= 60 ? `${minutes / 60}H` : `${minutes}m`} · MOCK`, left, 17, PALETTE.strong, 10, 'left', 600);
    const color = focusCandle.close >= focusCandle.open ? PALETTE.rise : PALETTE.fall;
    const metadataX = left + Math.min(185, ticker.length * 6 + 93);
    if (width > 620) {
      this.text(`O ${this.formatPrice(focusCandle.open)}   H ${this.formatPrice(focusCandle.high)}   L ${this.formatPrice(focusCandle.low)}   C ${this.formatPrice(focusCandle.close)}`, metadataX, 17, color, 10);
    } else if (width > 320) {
      this.text(`C ${this.formatPrice(focusCandle.close)}`, metadataX, 17, color, 10);
    }
    if (this.data.showMA) {
      this.line(left, 36, left + 13, 36, PALETTE.gold, 1.5);
      this.text('MA 20', left + 19, 36, PALETTE.gold, 9);
      this.line(left + 70, 36, left + 83, 36, PALETTE.violet, 1.5);
      this.text('MA 50', left + 89, 36, PALETTE.violet, 9);
    }
    if (this.data.showVolume && width > 340) {
      this.text(`VOL ${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(focusCandle.volume || 0)}`, left + (this.data.showMA ? 149 : 0), 36, PALETTE.text, 9);
    }
  }

  drawMovingAverage(candles, start, end, period, x, y, color) {
    const ctx = this.ctx;
    ctx.beginPath();
    let drawing = false;
    let sum = 0;
    const from = Math.max(0, start - period + 1);
    for (let index = from; index < end; index += 1) {
      sum += candles[index].close;
      if (index - period >= from) sum -= candles[index - period].close;
      if (index < start || index < period - 1) continue;
      const average = sum / period;
      if (drawing) ctx.lineTo(x(index - start), y(average));
      else { ctx.moveTo(x(index - start), y(average)); drawing = true; }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
