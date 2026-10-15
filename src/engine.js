import { STOCKS, STOCK_BY_ID } from './stocks.js';

export const INITIAL_CASH = 100_000;
export const LOAN_AMOUNT = 100_000;
export const LOAN_DURATION = 5 * 60 * 1000;
export const FEE_RATE = 0.0005;
export const MIN_MARGIN = 1;
const MINUTE = 60_000;
const HISTORY_LENGTH = 1440;
const SAVE_CANDLES = 180;
const MAX_POSITIONS = 200;
const MAX_PRICE = 1e12;
const finite = n => typeof n === 'number' && Number.isFinite(n);
const nonnegative = n => finite(n) && n >= 0 && n <= 1e18;
const positive = n => finite(n) && n > 0 && n <= MAX_PRICE;
const money = n => Math.round(n * 100) / 100;
const clampPrice = n => Math.max(0.0001, Math.min(MAX_PRICE, n));
const priceRound = n => Math.round(clampPrice(n) * 10000) / 10000;

export function estimateFee(amount, leverage) {
  return money(amount * leverage * FEE_RATE);
}

/** Spendable collateral after the opening fee, rounded down to a won cent. */
export function maxAffordableAmount(cash, leverage) {
  if (!nonnegative(cash) || !Number.isInteger(leverage) || leverage < 1 || leverage > 100) return 0;
  let amount = Math.min(1e12, Math.floor(cash / (1 + leverage * FEE_RATE) * 100) / 100);
  while (amount > 0 && amount + estimateFee(amount, leverage) > cash + 1e-7) amount = money(amount - 0.01);
  // Fee rounding may make the next cent affordable (especially the final ₩1).
  const next = money(amount + 0.01);
  if (next <= 1e12 && next + estimateFee(next, leverage) <= cash + 1e-7) amount = next;
  return Math.max(0, amount);
}

/** Entirely fictional, local-only trading simulator. No brokerage connection. */
export class TradingEngine {
  constructor({ saved, random = Math.random, now = Date.now } = {}) {
    this._random = typeof random === 'function' ? random : Math.random;
    this._clock = typeof now === 'function' ? now : () => now;
    const timestamp = this._timestamp();
    this._sequence = 0;
    this._lastTick = timestamp;
    this._pending = [];
    this.news = [];
    this.volatilityMultiplier = 1;
    this.restored = false;
    this.restoreWarning = null;
    this.state = this._freshState(timestamp);
    let source;
    if (saved != null) {
      try {
        source = typeof saved === 'string' ? JSON.parse(saved) : saved;
        this._validateSave(source);
        this.state = this._restoreState(source.state, timestamp);
        this.restored = true;
      } catch {
        source = undefined;
        this.restoreWarning = '저장 데이터가 손상되어 새 게임을 시작했습니다.';
      }
    }
    this.markets = {};
    for (const stock of STOCKS) {
      const quote = source?.markets?.[stock.id];
      const target = quote?.price ?? stock.price;
      const candles = this._seedCandles(stock, timestamp, target);
      if (quote?.candles?.length) {
        const restored = quote.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
        // Preserve recent visible candles exactly; older prehistory is illustrative.
        const cutoff = restored[0].time;
        const combined = candles.filter(c => c.time < cutoff).concat(restored);
        candles.splice(0, candles.length, ...combined.slice(-HISTORY_LENGTH));
      }
      this.markets[stock.id] = { price: target, previousClose: quote?.previousClose ?? target * (0.965 + this._rand() * 0.07), candles };
    }
    this._advanceRules(timestamp, this._pending);
    this._updatePeak();
  }

  _freshState(now) {
    return { cash: INITIAL_CASH, positions: [], history: [], loan: null, loanUsed: false,
      status: 'playing', startedAt: now, endedAt: null, gameoverReason: null,
      peakEquity: INITIAL_CASH, trades: 0, wins: 0 };
  }

  _timestamp(value) {
    const result = value === undefined ? this._clock() : value;
    if (!finite(result) || result < 0) throw new Error('유효하지 않은 게임 시간입니다.');
    return result;
  }

  _rand() {
    const n = this._random();
    return finite(n) ? Math.max(0, Math.min(0.999999999, n)) : 0.5;
  }

  _validatePosition(p) {
    return p && typeof p.id === 'string' && !!STOCK_BY_ID[p.stockId]
      && ['high', 'low'].includes(p.direction) && positive(p.entryPrice)
      && nonnegative(p.amount) && p.amount >= MIN_MARGIN
      && Number.isInteger(p.leverage) && p.leverage >= 1 && p.leverage <= 100
      && nonnegative(p.fee) && finite(p.openedAt);
  }

  _validateSave(save) {
    const s = save?.state;
    if (save?.version !== 1 || !s || !nonnegative(s.cash)
      || !Array.isArray(s.positions) || s.positions.length > MAX_POSITIONS
      || !s.positions.every(p => this._validatePosition(p))
      || new Set(s.positions.map(p => p.id)).size !== s.positions.length
      || !Array.isArray(s.history) || s.history.length > 500
      || !['playing', 'bankrupt', 'gameover'].includes(s.status)
      || typeof s.loanUsed !== 'boolean' || !finite(s.startedAt)
      || (s.endedAt != null && (!finite(s.endedAt) || s.endedAt < 0))
      || (s.gameoverReason != null && (typeof s.gameoverReason !== 'string' || s.gameoverReason.length > 300))
      || !nonnegative(s.peakEquity) || !Number.isInteger(s.trades) || s.trades < 0
      || !Number.isInteger(s.wins) || s.wins < 0 || s.wins > s.trades
      || (s.loan !== null && (!s.loan || s.loan.amount !== LOAN_AMOUNT || !finite(s.loan.dueAt) || !s.loanUsed))
      || !save.markets || typeof save.markets !== 'object') throw new Error('Invalid saved state');
    for (const [id, q] of Object.entries(save.markets)) {
      if (!STOCK_BY_ID[id]) continue;
      if (!q || !positive(q.price) || !positive(q.previousClose) || !Array.isArray(q.candles)
        || q.candles.length > HISTORY_LENGTH) throw new Error('Invalid market');
      let lastTime = -Infinity;
      for (const c of q.candles) {
        if (!Array.isArray(c) || c.length !== 6 || !c.every(finite)
          || c[0] <= lastTime || c[0] < 0 || !c.slice(1, 5).every(positive)
          || c[2] < Math.max(c[1], c[4]) || c[3] > Math.min(c[1], c[4]) || c[5] < 0) throw new Error('Invalid candle');
        lastTime = c[0];
      }
    }
    if (s.positions.some(p => !save.markets[p.stockId])) throw new Error('Missing position quote');
  }

  _restoreState(s, now) {
    return { cash: s.cash, positions: s.positions.map(p => ({
      id: p.id, stockId: p.stockId, direction: p.direction, amount: p.amount, margin: p.amount,
      leverage: p.leverage, entryPrice: p.entryPrice, openedAt: p.openedAt, fee: p.fee,
    })), history: s.history.filter(t => this._validatePosition(t) && finite(t.pnl) && nonnegative(t.value)
      && positive(t.exitPrice) && finite(t.closedAt)).slice(0, 200).map(t => ({ ...t })),
      loan: s.loan ? { amount: LOAN_AMOUNT, dueAt: s.loan.dueAt } : null,
      loanUsed: s.loanUsed, status: s.status, startedAt: s.startedAt,
      endedAt: s.status === 'gameover' ? (s.endedAt ?? now) : null,
      gameoverReason: s.status === 'gameover' ? (s.gameoverReason || '게임이 종료되었습니다.') : null,
      peakEquity: s.peakEquity, trades: s.trades, wins: s.wins };
  }

  _seedCandles(stock, now, target) {
    const result = [];
    let p = target;
    const end = Math.floor(now / MINUTE) * MINUTE;
    // Build backward so the last close equals the current quote without a jump.
    for (let i = HISTORY_LENGTH - 1; i >= 0; i--) {
      const close = p;
      const open = priceRound(close / (1 + (this._rand() - 0.5) * 0.008 * stock.volatility));
      const high = priceRound(Math.max(open, close) * (1 + this._rand() * 0.0025));
      const low = priceRound(Math.min(open, close) * (1 - this._rand() * 0.0025));
      result[i] = { time: end - (HISTORY_LENGTH - 1 - i) * MINUTE, open,
        high: Math.max(high, open, close), low: Math.min(low, open, close), close,
        volume: Math.floor(500 + this._rand() * 18000) };
      p = open;
    }
    return result;
  }

  equity() {
    return this.state.cash + this.state.positions.reduce((sum, p) => sum + this.positionValue(p), 0);
  }

  netEquity() {
    return this.equity() - (this.state.loan?.amount ?? 0);
  }

  positionValue(position) {
    const current = this.markets[position.stockId]?.price ?? position.entryPrice;
    const sign = position.direction === 'high' ? 1 : -1;
    return Math.max(0, position.amount * (1 + sign * (current / position.entryPrice - 1) * position.leverage));
  }

  positionPnl(position) {
    return this.positionValue(position) - position.amount - position.fee;
  }

  _updatePeak() {
    this.state.peakEquity = Math.max(this.state.peakEquity, this.netEquity());
  }

  _event(type, message, extras = {}) { return { type, message, ...extras }; }

  _endGame(now, message) {
    this.state.status = 'gameover';
    this.state.endedAt = now;
    this.state.gameoverReason = message;
  }

  _checkBankruptcy(events, now) {
    if (this.state.status === 'gameover') return;
    if (this.equity() < 1) {
      if (this.state.loanUsed) {
        const message = '더 이상 거래할 자금이 없습니다.';
        this._endGame(now, message);
        events.push(this._event('gameover', message, { reason: 'bankrupt' }));
      } else if (this.state.status !== 'bankrupt') {
        this.state.status = 'bankrupt';
        events.push(this._event('bankrupt', '자금이 소진되었습니다. 마지막 기회로 100,000원을 빌릴 수 있습니다.'));
      }
    } else if (this.state.status === 'bankrupt') {
      this.state.status = 'playing';
    }
  }

  _closeInternal(position, now, reason = 'manual') {
    const value = this.positionValue(position);
    const pnl = value - position.amount - position.fee;
    const trade = { ...position, type: reason === 'liquidation' ? 'liquidation' : 'close',
      closedAt: now, exitPrice: this.markets[position.stockId].price,
      value, pnl, reason };
    this.state.cash += value;
    this.state.positions = this.state.positions.filter(p => p.id !== position.id);
    this.state.history.unshift(trade);
    this.state.history.length = Math.min(this.state.history.length, 200);
    this.state.trades += 1;
    if (pnl > 0) this.state.wins += 1;
    return trade;
  }

  _advanceRules(now, events) {
    if (this.state.status === 'gameover') return;
    let resolutionAt = now;
    for (const p of [...this.state.positions]) {
      if (this.positionValue(p) <= 0) {
        const trade = this._closeInternal(p, now, 'liquidation');
        events.push(this._event('liquidation', `${STOCK_BY_ID[p.stockId].name} 포지션이 강제 청산되었습니다.`, { position: p, trade }));
      }
    }
    if (this.state.loan && now >= this.state.loan.dueAt) {
      resolutionAt = this.state.loan.dueAt;
      for (const p of [...this.state.positions]) this._closeInternal(p, resolutionAt, 'deadline');
      if (this.state.cash >= this.state.loan.amount) {
        this.state.cash -= this.state.loan.amount;
        this.state.loan = null;
        events.push(this._event('repay', '만기가 되어 포지션을 정산하고 대출금 100,000원을 자동 상환했습니다.', { automatic: true }));
      } else {
        const message = '대출 상환 기한이 지났습니다. 100,000원을 갚지 못했습니다.';
        this._endGame(resolutionAt, message);
        events.push(this._event('gameover', message, { reason: 'debt' }));
        return;
      }
    }
    this._checkBankruptcy(events, resolutionAt);
  }

  _beforeAction(now) {
    const timestamp = this._timestamp(now);
    this._advanceRules(timestamp, this._pending);
    return timestamp;
  }

  _requirePlaying() {
    if (this.state.status === 'gameover') throw new Error('게임이 종료되었습니다. 새 게임을 시작해 주세요.');
    if (this.state.status === 'bankrupt') throw new Error('거래 자금이 없습니다. 대출 여부를 선택해 주세요.');
  }

  openPosition({ stockId, direction, amount, leverage }, now) {
    const timestamp = this._beforeAction(now);
    this._requirePlaying();
    if (!STOCK_BY_ID[stockId]) throw new Error('존재하지 않는 종목입니다.');
    if (!['high', 'low'].includes(direction)) throw new Error('HIGH 또는 LOW를 선택해 주세요.');
    if (!finite(amount) || amount < MIN_MARGIN || amount > 1e12) throw new Error('주문 금액은 1원 이상이어야 합니다.');
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > 100) throw new Error('레버리지는 1배부터 100배까지 선택할 수 있습니다.');
    if (this.state.positions.length >= MAX_POSITIONS) throw new Error('열린 포지션은 최대 200개입니다.');
    const margin = money(amount);
    const fee = estimateFee(margin, leverage);
    if (margin + fee > this.state.cash + 1e-7) throw new Error('주문 금액과 수수료를 합한 금액이 보유 현금을 초과합니다.');
    const position = { id: `${timestamp.toString(36)}-${(++this._sequence).toString(36)}-${Math.floor(this._rand() * 0xffffff).toString(36)}`,
      stockId, direction, amount: margin, margin, leverage, entryPrice: this.markets[stockId].price,
      openedAt: timestamp, fee };
    // A restored session could produce the same deterministic id at the same time.
    while (this.state.positions.some(p => p.id === position.id)) position.id += '-n';
    this.state.cash = Math.max(0, this.state.cash - margin - fee);
    this.state.positions.push(position);
    this._updatePeak();
    return position;
  }

  closePosition(id, now) {
    const timestamp = this._beforeAction(now);
    this._requirePlaying();
    const position = this.state.positions.find(p => p.id === id);
    if (!position) throw new Error('이미 정산되었거나 존재하지 않는 포지션입니다.');
    const trade = this._closeInternal(position, timestamp);
    this._checkBankruptcy(this._pending, timestamp);
    this._updatePeak();
    return trade;
  }

  closeAll(now) {
    const timestamp = this._beforeAction(now);
    this._requirePlaying();
    const trades = [...this.state.positions].map(p => this._closeInternal(p, timestamp));
    this._checkBankruptcy(this._pending, timestamp);
    this._updatePeak();
    return trades;
  }

  borrow(now) {
    const timestamp = this._beforeAction(now);
    if (this.state.status === 'gameover') throw new Error('게임이 종료되었습니다.');
    if (this.state.loanUsed || this.state.loan) throw new Error('대출 기회는 한 번뿐입니다.');
    if (this.state.status !== 'bankrupt') throw new Error('자금이 소진되었을 때만 대출을 받을 수 있습니다.');
    this.state.cash += LOAN_AMOUNT;
    this.state.loan = { amount: LOAN_AMOUNT, dueAt: timestamp + LOAN_DURATION };
    this.state.loanUsed = true;
    this.state.status = 'playing';
    this._pending.push(this._event('borrow', '100,000원을 빌렸습니다. 5분 안에 상환하세요.', { dueAt: this.state.loan.dueAt }));
    return this.state.loan;
  }

  repay(now) {
    const timestamp = this._beforeAction(now);
    this._requirePlaying();
    if (!this.state.loan) throw new Error('상환할 대출이 없습니다.');
    if (this.state.cash < this.state.loan.amount) throw new Error('상환하려면 현금 100,000원이 필요합니다. 포지션을 먼저 정산해 주세요.');
    this.state.cash -= this.state.loan.amount;
    this.state.loan = null;
    this._pending.push(this._event('repay', '대출금 100,000원을 상환했습니다.', { automatic: false }));
    this._checkBankruptcy(this._pending, timestamp);
    this._updatePeak();
    return true;
  }

  declineLoan(now) {
    const timestamp = this._beforeAction(now);
    if (this.state.status !== 'bankrupt') throw new Error('지금은 대출을 선택할 단계가 아닙니다.');
    const message = '마지막 대출을 거절했습니다.';
    this._endGame(timestamp, message);
    this._pending.push(this._event('gameover', message, { reason: 'declined' }));
  }

  tick(now) {
    const timestamp = this._timestamp(now);
    const events = this._pending.splice(0);
    // Wall-clock debt deadlines have priority over new random price movement.
    this._advanceRules(timestamp, events);
    if (this.state.status === 'gameover') return events;
    if (timestamp <= this._lastTick) return events;
    const elapsed = Math.min(4, (timestamp - this._lastTick) / 1000);
    this._lastTick = timestamp;
    const multiplier = finite(this.volatilityMultiplier) ? Math.max(0, Math.min(3, this.volatilityMultiplier)) : 1;
    const shared = (this._rand() - 0.5) * 0.0011;
    const headlineStock = this._rand() < 0.012 * elapsed ? STOCKS[Math.floor(this._rand() * STOCKS.length)] : null;
    const headlineShock = (this._rand() < 0.5 ? -1 : 1) * (0.012 + this._rand() * 0.018);
    for (const stock of STOCKS) {
      const market = this.markets[stock.id];
      const before = market.price;
      const shock = (shared + (this._rand() - 0.5) * 0.0028 * stock.volatility) * Math.sqrt(elapsed) * multiplier;
      const newsMove = headlineStock?.id === stock.id ? headlineShock * multiplier : 0;
      market.price = priceRound(before * Math.max(0.75, 1 + shock + newsMove));
      const minute = Math.floor(timestamp / MINUTE) * MINUTE;
      let candle = market.candles.at(-1);
      if (minute > candle.time) {
        const start = Math.max(candle.time + MINUTE, minute - (HISTORY_LENGTH - 1) * MINUTE);
        for (let time = start; time <= minute; time += MINUTE) {
          candle = { time, open: before, high: before, low: before, close: before, volume: 0 };
          market.candles.push(candle);
        }
        if (market.candles.length > HISTORY_LENGTH) market.candles.splice(0, market.candles.length - HISTORY_LENGTH);
      }
      candle.close = market.price;
      candle.high = Math.max(candle.high, market.price);
      candle.low = Math.min(candle.low, market.price);
      candle.volume += Math.floor((25 + this._rand() * 600) * elapsed);
    }
    if (headlineStock) {
      const up = headlineShock > 0;
      const news = { id: `news-${timestamp}`, time: timestamp, stockId: headlineStock.id, positive: up,
        title: `${headlineStock.name}, ${up ? '가상 호재 유입으로 매수세 확대' : '가상 악재에 투자 심리 위축'}`,
        message: '시뮬레이션에서 무작위로 생성한 가상 뉴스입니다.' };
      this.news.unshift(news);
      this.news.length = Math.min(this.news.length, 20);
      events.push(this._event('news', news.title, { news }));
    }
    this._advanceRules(timestamp, events);
    this._updatePeak();
    return events;
  }

  getCandles(stockId, minutes = 1) {
    if (!this.markets[stockId]) return [];
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('유효하지 않은 차트 간격입니다.');
    const source = this.markets[stockId].candles;
    if (minutes === 1) return source.map(c => ({ ...c }));
    const duration = minutes * MINUTE;
    const result = [];
    for (const c of source) {
      const time = Math.floor(c.time / duration) * duration;
      const last = result.at(-1);
      if (last && last.time === time) {
        last.high = Math.max(last.high, c.high);
        last.low = Math.min(last.low, c.low);
        last.close = c.close;
        last.volume += c.volume;
      } else result.push({ ...c, time });
    }
    return result;
  }

  serialize() {
    const markets = {};
    for (const stock of STOCKS) {
      const market = this.markets[stock.id];
      markets[stock.id] = { price: market.price, previousClose: market.previousClose,
        candles: market.candles.slice(-SAVE_CANDLES).map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]) };
    }
    return { version: 1, state: JSON.parse(JSON.stringify(this.state)), markets };
  }
}
