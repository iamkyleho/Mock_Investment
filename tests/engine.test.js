import test from 'node:test';
import assert from 'node:assert/strict';
import { TradingEngine, estimateFee, maxAffordableAmount, INITIAL_CASH, LOAN_AMOUNT, LOAN_DURATION } from '../src/engine.js';
import { STOCKS } from '../src/stocks.js';

const NOW = 1_790_000_000_000;
const make = () => new TradingEngine({ random: () => 0.5, now: () => NOW });
const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);
function position(engine, overrides = {}) {
  engine.markets.nvidia.price = 100;
  return engine.openPosition({ stockId: 'nvidia', direction: 'high', amount: 10_000, leverage: 5, ...overrides }, NOW);
}
function borrowFromZero(engine) {
  engine.state.cash = 0;
  engine.tick(NOW);
  return engine.borrow(NOW);
}

test('catalog contains unique domestic and international fictional instruments', () => {
  assert.ok(STOCKS.length >= 60);
  assert.equal(new Set(STOCKS.map(s => s.id)).size, STOCKS.length);
  assert.deepEqual(new Set(STOCKS.map(s => s.market)), new Set(['KR', 'US', 'JP', 'HK', 'EU']));
  assert.ok(STOCKS.every(s => s.price > 0 && s.currency && s.name));
});

test('starts with ₩100,000, no liabilities, and meaningful price history', () => {
  const engine = make();
  assert.equal(engine.state.cash, INITIAL_CASH);
  assert.equal(engine.equity(), INITIAL_CASH);
  assert.equal(engine.netEquity(), INITIAL_CASH);
  assert.equal(engine.state.loan, null);
  assert.equal(engine.state.status, 'playing');
  assert.equal(engine.getCandles('nvidia', 1).length, 1440);
  assert.equal(engine.getCandles('nvidia', 1).at(-1).close, engine.markets.nvidia.price);
});

test('HIGH settles leveraged return with opening fee, no FX conversion assumptions', () => {
  const engine = make();
  const p = position(engine);
  assert.equal(estimateFee(10_000, 5), 25);
  assert.equal(engine.state.cash, 89_975);
  engine.markets.nvidia.price = 110;
  near(engine.positionValue(p), 15_000);
  near(engine.positionPnl(p), 4975);
  near(engine.netEquity(), 104_975);
  const trade = engine.closePosition(p.id, NOW);
  near(trade.pnl, 4975);
  near(engine.state.cash, 104_975);
  assert.equal(engine.state.positions.length, 0);
  assert.equal(engine.state.trades, 1);
  assert.equal(engine.state.wins, 1);
  assert.equal(engine.state.history[0].id, p.id);
});

test('LOW profits on falling price and loses on rising price', () => {
  const engine = make();
  const p = position(engine, { direction: 'low', leverage: 10 });
  engine.markets.nvidia.price = 97;
  near(engine.positionValue(p), 13_000);
  near(engine.positionPnl(p), 2950);
  engine.markets.nvidia.price = 105;
  near(engine.positionValue(p), 5000);
  near(engine.positionPnl(p), -5050);
});

test('rejects invalid and unaffordable orders without altering the account', () => {
  const engine = make();
  for (const change of [{ stockId: 'fake' }, { direction: 'sideways' }, { amount: NaN }, { amount: 0.99 },
    { amount: 100_000 }, { amount: Infinity }, { leverage: 0 }, { leverage: 101 }, { leverage: 1.5 }]) {
    assert.throws(() => position(engine, change));
    assert.equal(engine.state.cash, INITIAL_CASH);
    assert.equal(engine.state.positions.length, 0);
  }
});

test('no cash with recoverable position collateral is not bankruptcy', () => {
  const engine = make();
  position(engine, { amount: 99_950, leverage: 1 });
  assert.ok(engine.state.cash < 1);
  const events = engine.tick(NOW);
  assert.equal(engine.state.status, 'playing');
  assert.ok(engine.equity() > 99_000);
  assert.equal(events.some(e => e.type === 'bankrupt'), false);
  assert.throws(() => engine.borrow(NOW));
});

test('small balances can keep trading; maximum orders account for fee rounding', () => {
  const engine = make();
  engine.state.cash = 500;
  const amount = maxAffordableAmount(engine.state.cash, 100);
  const p = position(engine, { amount, leverage: 100 });
  assert.ok(p.amount > 1 && p.amount < 500);
  assert.ok(engine.state.cash >= 0 && engine.state.cash < 0.02);
  engine.markets.nvidia.price = 1;
  engine.tick(NOW);
  assert.equal(engine.state.status, 'bankrupt');
  assert.equal(maxAffordableAmount(1, 1), 1);
  for (const leverage of [1, 5, 10, 20, 50, 100]) {
    for (const cash of [1, 1.05, 1.11, 2.36, 14.99, 500, 100_000, 99_999.99]) {
      const maximum = maxAffordableAmount(cash, leverage);
      assert.ok(maximum + estimateFee(maximum, leverage) <= cash + 1e-7);
      assert.ok(maximum >= 0);
      const nextCent = Math.round((maximum + 0.01) * 100) / 100;
      assert.ok(nextCent + estimateFee(nextCent, leverage) > cash + 1e-7);
    }
  }
});

for (const direction of ['high', 'low']) {
  test(`${direction.toUpperCase()} gap-through loss is capped at posted collateral`, () => {
    const engine = make();
    const p = position(engine, { direction, leverage: 100 });
    const availableCash = engine.state.cash;
    engine.markets.nvidia.price = direction === 'high' ? 1 : 1000;
    assert.equal(engine.positionValue(p), 0);
    const events = engine.tick(NOW);
    assert.equal(engine.state.cash, availableCash);
    assert.equal(engine.state.positions.length, 0);
    assert.equal(engine.state.history[0].pnl, -10_500);
    assert.ok(events.some(e => e.type === 'liquidation'));
    assert.ok(engine.state.cash >= 0);
  });
}

test('closeAll settles every position once and includes each fee', () => {
  const engine = make();
  const one = position(engine, { amount: 5000, leverage: 1 });
  const two = position(engine, { direction: 'low', amount: 5000, leverage: 1 });
  assert.notEqual(one.id, two.id);
  engine.markets.nvidia.price = 120;
  const trades = engine.closeAll(NOW);
  assert.equal(trades.length, 2);
  near(engine.equity(), 99_995);
  assert.equal(engine.state.history.length, 2);
  assert.equal(engine.state.trades, 2);
  assert.equal(engine.closeAll(NOW).length, 0);
  assert.throws(() => engine.closePosition(one.id, NOW));
});

test('bankruptcy offers exactly one real-time five-minute loan', () => {
  const engine = make();
  engine.state.cash = 0;
  const events = engine.tick(NOW);
  assert.ok(events.some(e => e.type === 'bankrupt'));
  assert.equal(engine.state.status, 'bankrupt');
  assert.throws(() => position(engine));
  const loan = engine.borrow(NOW);
  assert.equal(loan.amount, LOAN_AMOUNT);
  assert.equal(loan.dueAt, NOW + LOAN_DURATION);
  assert.equal(engine.state.cash, 100_000);
  assert.equal(engine.equity(), 100_000);
  assert.equal(engine.netEquity(), 0);
  assert.equal(engine.state.status, 'playing');
  assert.throws(() => engine.borrow(NOW));
  engine.state.cash = 0;
  assert.ok(engine.tick(NOW).some(e => e.type === 'gameover'));
  assert.equal(engine.state.status, 'gameover');
});

test('declining bankruptcy loan ends the game and freezes prices', () => {
  const engine = make();
  engine.state.cash = 0;
  engine.tick(NOW);
  engine.declineLoan(NOW);
  const previous = engine.markets.nvidia.price;
  engine.tick(NOW + 60_000);
  assert.equal(engine.state.status, 'gameover');
  assert.equal(engine.markets.nvidia.price, previous);
  assert.throws(() => engine.borrow(NOW));
});

test('repayment needs available cash, not just marked position equity', () => {
  const engine = make();
  borrowFromZero(engine);
  position(engine, { amount: 20_000, leverage: 1 });
  engine.markets.nvidia.price = 150;
  assert.ok(engine.equity() > 100_000);
  assert.throws(() => engine.repay(NOW), /현금/);
  engine.closeAll(NOW);
  assert.equal(engine.repay(NOW), true);
  assert.equal(engine.state.loan, null);
  near(engine.state.cash, 9990);
  assert.equal(engine.state.status, 'playing');
  assert.throws(() => engine.repay(NOW));
});

test('debt deadline settles positions and automatically repays if affordable', () => {
  const engine = make();
  const loan = borrowFromZero(engine);
  position(engine, { amount: 50_000, leverage: 2 });
  engine.markets.nvidia.price = 110;
  const events = engine.tick(loan.dueAt);
  assert.equal(engine.state.positions.length, 0);
  assert.equal(engine.state.loan, null);
  near(engine.state.cash, 9950);
  assert.equal(engine.state.status, 'playing');
  assert.ok(events.some(e => e.type === 'repay' && e.automatic));
  assert.equal(engine.state.history[0].reason, 'deadline');
});

test('unpaid debt deadline ends game even when positive equity remains', () => {
  const engine = make();
  const loan = borrowFromZero(engine);
  position(engine, { amount: 20_000, leverage: 1 });
  const events = engine.tick(loan.dueAt);
  assert.equal(engine.state.status, 'gameover');
  assert.equal(engine.state.positions.length, 0);
  assert.ok(engine.state.cash > 0);
  assert.ok(events.some(e => e.type === 'gameover' && e.reason === 'debt'));
  assert.throws(() => position(engine));
});

test('game-over time and Korean reason stay fixed across reloads', () => {
  const engine = make();
  const loan = borrowFromZero(engine);
  position(engine);
  engine.tick(loan.dueAt + 30_000);
  assert.equal(engine.state.endedAt, loan.dueAt);
  assert.equal(engine.state.gameoverReason, '대출 상환 기한이 지났습니다. 100,000원을 갚지 못했습니다.');
  const restored = new TradingEngine({ saved: engine.serialize(), random: () => 0.5, now: () => loan.dueAt + 86_400_000 });
  assert.equal(restored.state.endedAt, loan.dueAt);
  assert.equal(restored.state.gameoverReason, engine.state.gameoverReason);
  restored.tick(loan.dueAt + 172_800_000);
  assert.equal(restored.state.endedAt, loan.dueAt);

  const declined = make();
  declined.state.cash = 0;
  declined.tick(NOW);
  declined.declineLoan(NOW + 1000);
  assert.equal(declined.state.endedAt, NOW + 1000);
  assert.equal(declined.state.gameoverReason, '마지막 대출을 거절했습니다.');

  const bankrupt = make();
  borrowFromZero(bankrupt);
  bankrupt.state.cash = 0;
  bankrupt.tick(NOW + 2000);
  assert.equal(bankrupt.state.endedAt, NOW + 2000);
  assert.equal(bankrupt.state.gameoverReason, '더 이상 거래할 자금이 없습니다.');

  const idleLoan = make();
  const idleDueAt = borrowFromZero(idleLoan).dueAt;
  idleLoan.tick(idleDueAt + 86_400_000);
  assert.equal(idleLoan.state.loan, null);
  assert.equal(idleLoan.state.endedAt, idleDueAt);
  assert.equal(idleLoan.state.gameoverReason, '더 이상 거래할 자금이 없습니다.');
});

test('legacy saves without game-over metadata remain compatible', () => {
  const engine = make();
  engine.state.cash = 0;
  engine.tick(NOW);
  engine.declineLoan(NOW);
  const saved = engine.serialize();
  delete saved.state.endedAt;
  delete saved.state.gameoverReason;
  const restored = new TradingEngine({ saved, random: () => 0.5, now: () => NOW + 1000 });
  assert.equal(restored.restored, true);
  assert.equal(restored.state.status, 'gameover');
  assert.equal(restored.state.endedAt, NOW + 1000);
  assert.equal(restored.state.gameoverReason, '게임이 종료되었습니다.');
  assert.equal(make().state.endedAt, null);
  assert.equal(make().state.gameoverReason, null);
});

test('actions cannot evade an expired loan before the next market tick', () => {
  const engine = make();
  const loan = borrowFromZero(engine);
  position(engine);
  assert.throws(() => engine.openPosition({ stockId: 'apple', direction: 'high', amount: 1000, leverage: 1 }, loan.dueAt));
  assert.equal(engine.state.status, 'gameover');
});

test('save restores quotes, positions and deadline; overdue reload resolves immediately', () => {
  const engine = make();
  const loan = borrowFromZero(engine);
  const p = position(engine);
  const saved = engine.serialize();
  const restored = new TradingEngine({ saved: JSON.stringify(saved), random: () => 0.5, now: () => NOW + 1000 });
  assert.equal(restored.restored, true);
  assert.equal(restored.state.positions[0].id, p.id);
  assert.equal(restored.markets.nvidia.price, 100);
  assert.equal(restored.state.loan.dueAt, loan.dueAt);
  near(restored.equity(), engine.equity());
  const overdue = new TradingEngine({ saved, random: () => 0.5, now: () => loan.dueAt + 1 });
  assert.equal(overdue.state.status, 'gameover');
  assert.equal(overdue.state.positions.length, 0);
});

test('malformed, nonfinite, negative and unknown-version storage resets safely', () => {
  const baseline = make().serialize();
  for (const bad of ['{broken', { ...baseline, version: 999 },
    { ...baseline, state: { ...baseline.state, cash: -1 } },
    { ...baseline, state: { ...baseline.state, cash: Infinity } },
    { ...baseline, state: { ...baseline.state, positions: [{ stockId: 'fake' }] } },
    { ...baseline, markets: { nvidia: { price: 0, previousClose: 100, candles: [] } } }]) {
    const restored = new TradingEngine({ saved: bad, random: () => 0.5, now: () => NOW });
    assert.equal(restored.restored, false);
    assert.equal(restored.state.cash, INITIAL_CASH);
    assert.equal(restored.state.status, 'playing');
    assert.ok(restored.restoreWarning);
  }
});

test('candle periods aggregate identical base history without changing market state', () => {
  const engine = make();
  const original = engine.markets.nvidia.price;
  const one = engine.getCandles('nvidia', 1);
  for (const period of [3, 5, 15, 30, 60]) {
    const aggregated = engine.getCandles('nvidia', period);
    assert.ok(aggregated.length < one.length);
    assert.equal(aggregated.at(-1).close, one.at(-1).close);
    assert.equal(aggregated.reduce((sum, c) => sum + c.volume, 0), one.reduce((sum, c) => sum + c.volume, 0));
    assert.ok(aggregated.every(c => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close)));
    assert.equal(engine.markets.nvidia.price, original);
  }
  const copy = engine.getCandles('nvidia', 1);
  copy[0].close = 0;
  assert.notEqual(engine.markets.nvidia.candles[0].close, 0);
});

test('minute transitions retain OHLC bounds and bounded history', () => {
  const engine = make();
  engine._random = () => 0.9;
  const before = engine.markets.nvidia.price;
  engine.tick(NOW + 120_000);
  const candle = engine.markets.nvidia.candles.at(-1);
  assert.ok(engine.markets.nvidia.price > before);
  assert.equal(candle.close, engine.markets.nvidia.price);
  assert.ok(candle.high >= Math.max(candle.open, candle.close));
  assert.ok(candle.low <= Math.min(candle.open, candle.close));
  assert.equal(engine.markets.nvidia.candles.length, 1440);
});

test('volatility settings affect simulated prices and compact save fits browser storage', () => {
  const calm = make();
  const wild = make();
  calm._random = wild._random = () => 0.9;
  calm.volatilityMultiplier = 0.55;
  wild.volatilityMultiplier = 1.8;
  calm.tick(NOW + 1000);
  wild.tick(NOW + 1000);
  assert.ok(wild.markets.nvidia.price > calm.markets.nvidia.price);
  const encoded = JSON.stringify(wild.serialize());
  assert.ok(encoded.length * 2 < 4 * 1024 * 1024, `UTF-16 storage use: ${encoded.length * 2}`);
});
