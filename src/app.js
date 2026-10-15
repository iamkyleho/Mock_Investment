import { TradingEngine, estimateFee, maxAffordableAmount, INITIAL_CASH, MIN_MARGIN } from './engine.js';
import { STOCKS, STOCK_BY_ID } from './stocks.js';
import { MarketChart } from './chart.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const SAVE_KEY = 'mock-exchange-game-v1';
const PREF_KEY = 'mock-exchange-preferences-v1';
const money = value => `₩${Math.round(value).toLocaleString('ko-KR')}`;
const signedMoney = value => `${value > 0 ? '+' : value < 0 ? '−' : ''}₩${Math.round(Math.abs(value)).toLocaleString('ko-KR')}`;
const percent = value => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const colorClass = value => value >= 0 ? 'up' : 'down';
const nativePrice = (value, stock, symbol = true) => `${symbol ? stock.symbol : ''}${value.toLocaleString('en-US', {minimumFractionDigits: ['KRW', 'JPY'].includes(stock.currency) ? 0 : 2, maximumFractionDigits: ['KRW', 'JPY'].includes(stock.currency) ? 0 : 2})}`;
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = name => `<svg><use href="#i-${name}"/></svg>`;
const timeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const defaults = {selected:'nvidia',interval:1,chartType:'candles',showMA:true,showVolume:true,sound:false,volatility:1,favorites:['nvidia','samsung','apple','tesla','skhynix']};

let preferences = {...defaults};
let saved;
let storageAvailable = true;
try {
  saved = localStorage.getItem(SAVE_KEY);
  const stored = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
  if (stored && typeof stored === 'object') {
    preferences = {...defaults, ...stored};
    if (!STOCK_BY_ID[preferences.selected]) preferences.selected = defaults.selected;
    if (![1,3,5,15,60].includes(preferences.interval)) preferences.interval = 1;
    if (!['candles','line'].includes(preferences.chartType)) preferences.chartType = 'candles';
    if (![.55,1,1.8].includes(preferences.volatility)) preferences.volatility = 1;
    preferences.favorites = Array.isArray(preferences.favorites) ? preferences.favorites.filter(id => STOCK_BY_ID[id]) : defaults.favorites;
    for (const key of ['showMA','showVolume','sound']) preferences[key] = typeof preferences[key] === 'boolean' ? preferences[key] : defaults[key];
  }
} catch { storageAvailable = false; }

let engine = new TradingEngine({saved});
engine.volatilityMultiplier = preferences.volatility;
let selected = preferences.selected;
let direction = 'high';
let leverage = 1;
let marketFilter = 'all';
let favoritesOnly = false;
let portfolioTab = 'positions';
let portfolioSignature = '';
let visibleStocks = [];
let lastSave = 0;
let lastStatus = null;
let gameoverTime = null;
let audioContext;
const chart = new MarketChart($('#market-chart'));
const preferredOrder = ['nvidia','samsung','skhynix','apple','tesla','microsoft','naver','hyundai','amazon','meta','amd','tsmc','palantir'];
const stockOrder = [...preferredOrder.map(id => STOCK_BY_ID[id]).filter(Boolean),...STOCKS.filter(stock => !preferredOrder.includes(stock.id))];

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(engine.serialize()));
    localStorage.setItem(PREF_KEY, JSON.stringify(preferences));
    $('#save-status').textContent = '자동 저장됨';
    storageAvailable = true;
  } catch {
    $('#save-status').textContent = '저장 공간 부족 · 이번 세션만 유지';
    storageAvailable = false;
  }
  lastSave = Date.now();
}

function toast(message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  const mark = document.createElement('span');
  mark.className = 'toast-icon';
  mark.textContent = type === 'error' ? '!' : type === 'success' ? '✓' : '↗';
  const text = document.createElement('span');
  text.textContent = message;
  element.append(mark,text);
  $('#toast-container').append(element);
  if ($('#toast-container').children.length > 4) $('#toast-container').firstElementChild.remove();
  setTimeout(() => element.remove(),4500);
}

function playSound(type='trade') {
  if (!preferences.sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    audioContext.resume();
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.connect(gain); gain.connect(audioContext.destination);
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(type === 'error' ? 220 : 660,audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(type === 'error' ? 110 : 990,audioContext.currentTime+.13);
    gain.gain.setValueAtTime(.035,audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001,audioContext.currentTime+.18);
    oscillator.start(); oscillator.stop(audioContext.currentTime+.2);
  } catch { /* Audio is optional and never blocks a trade. */ }
}

function refreshStockList() {
  const query = $('#stock-search').value.trim().toLowerCase();
  visibleStocks = stockOrder.filter(stock => (marketFilter === 'all' || (marketFilter === 'global' ? stock.market !== 'KR' : stock.market === 'KR'))
    && (!favoritesOnly || preferences.favorites.includes(stock.id))
    && `${stock.name} ${stock.ticker} ${stock.exchange} ${stock.id} ${stock.sector}`.toLowerCase().includes(query));
  $('#stock-count').textContent = visibleStocks.length;
  $('#stock-list').innerHTML = visibleStocks.length ? visibleStocks.map(stock => `<button class="stock-row ${stock.id === selected ? 'selected' : ''}" data-stock="${stock.id}" aria-label="${escapeHTML(stock.name)} 선택" aria-pressed="${stock.id === selected}"><span class="stock-logo" style="--logo-color:${stock.color}">${escapeHTML(stock.initials)}</span><span class="stock-identity"><strong>${escapeHTML(stock.name)}</strong><small>${escapeHTML(stock.ticker)}<span class="stock-country">${stock.market}</span></small></span><span class="stock-price"><b data-quote="${stock.id}"></b><span data-change="${stock.id}"></span></span></button>`).join('') : '<div class="empty-search">조건에 맞는 종목이 없어요.<br/>다른 검색어를 입력해 주세요.</div>';
  updateStockPrices();
}

function updateStockPrices() {
  for (const stock of visibleStocks) {
    const market = engine.markets[stock.id];
    const change = (market.price/market.previousClose-1)*100;
    const priceNode = $(`[data-quote="${stock.id}"]`);
    if (!priceNode) continue;
    priceNode.textContent = nativePrice(market.price,stock);
    const changeNode = $(`[data-change="${stock.id}"]`);
    changeNode.textContent = percent(change);
    changeNode.className = colorClass(change);
  }
}

function selectStock(id) {
  if (!STOCK_BY_ID[id]) return;
  selected = preferences.selected = id;
  for (const row of $$('.stock-row')) {
    row.classList.toggle('selected',row.dataset.stock === selected);
    row.setAttribute('aria-pressed',String(row.dataset.stock === selected));
  }
  chart.resetView();
  updateInstrument();
  updateChart();
  updateOrder();
  save();
}

function updateInstrument() {
  const stock = STOCK_BY_ID[selected];
  const market = engine.markets[selected];
  const change = (market.price/market.previousClose-1)*100;
  const logo = $('#selected-logo');
  logo.style.setProperty('--logo-color',stock.color);
  logo.textContent = stock.initials;
  $('#selected-name').textContent = stock.name;
  $('#selected-meta').textContent = `${stock.ticker} · ${stock.exchange} · ${stock.sector}`;
  $('#selected-price').textContent = nativePrice(market.price,stock);
  $('#selected-price').className = colorClass(change);
  $('#selected-change').textContent = `${percent(change)} (${market.price>=market.previousClose?'+':'−'}${nativePrice(Math.abs(market.price-market.previousClose),stock)})`;
  $('#selected-change').className = colorClass(change);
  $('#selected-favorite').classList.toggle('favorite-active',preferences.favorites.includes(selected));
  $('#selected-favorite').setAttribute('aria-pressed',String(preferences.favorites.includes(selected)));
  $('#selected-favorite').setAttribute('aria-label',preferences.favorites.includes(selected)?'관심 종목 해제':'관심 종목 추가');
  const candles = market.candles;
  $('#day-high').textContent = nativePrice(Math.max(...candles.map(c=>c.high)),stock);
  $('#day-low').textContent = nativePrice(Math.min(...candles.map(c=>c.low)),stock);
  const volume = candles.reduce((sum,c)=>sum+c.volume,0);
  $('#day-volume').textContent = `${(volume/1e6).toFixed(2)}M`;
}

function updateChart() {
  chart.update({candles:engine.getCandles(selected,preferences.interval),positions:engine.state.positions.filter(p=>p.stockId===selected),stock:STOCK_BY_ID[selected],interval:preferences.interval,chartType:preferences.chartType,showMA:preferences.showMA,showVolume:preferences.showVolume});
}

const indices = [
  {name:'KOSPI',base:2684.52,stocks:['samsung','skhynix','hyundai']},
  {name:'KOSDAQ',base:842.36,stocks:['ecopro','hlb','jyp']},
  {name:'NASDAQ',base:17892.16,stocks:['nvidia','apple','microsoft']},
  {name:'S&P 500',base:5634.61,stocks:['amazon','meta','google']},
  {name:'NIKKEI 225',base:38421.37,stocks:['toyota','sony','nintendo']}
];
function updateIndices() {
  $('#market-strip').innerHTML = indices.map(index=>{
    const available = index.stocks.filter(id=>engine.markets[id]);
    const change = available.reduce((sum,id)=>sum+(engine.markets[id].price/engine.markets[id].previousClose-1),0)/Math.max(available.length,1);
    const series = available.length ? engine.markets[available[0]].candles.slice(-20).map(c=>c.close) : [1,1];
    const min = Math.min(...series), span = Math.max(...series)-min || 1;
    const line = series.map((value,i)=>`${i?'L':'M'}${(i/(series.length-1)*48).toFixed(1)},${(18-(value-min)/span*15).toFixed(1)}`).join(' ');
    return `<div class="market-index"><span class="index-label">${index.name}</span><b class="index-value">${(index.base*(1+change)).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</b><span class="index-change ${colorClass(change)}">${percent(change*100)}</span><svg class="index-spark ${colorClass(change)}" viewBox="0 0 48 20"><path d="${line}"/></svg></div>`;
  }).join('');
}

function maxMargin(fraction=1) {
  return maxAffordableAmount(Math.max(0,engine.state.cash*fraction),leverage);
}

function updateOrder() {
  const stock = STOCK_BY_ID[selected];
  const amount = Number($('#order-amount').value);
  const validAmount = Number.isFinite(amount)&&amount>=MIN_MARGIN;
  const fee = validAmount ? estimateFee(amount,leverage) : 0;
  $('#available-cash').textContent = money(engine.state.cash);
  $('#order-stock').textContent = `${stock.name} · ${stock.ticker}`;
  $('#order-notional').textContent = money(validAmount?amount*leverage:0);
  $('#order-entry').textContent = nativePrice(engine.markets[selected].price,stock);
  $('#order-fee').textContent = fee>0&&fee<1?`₩${fee.toFixed(2)}`:money(fee);
  $('#order-liquidation').textContent = `${direction==='high'?'−':'+'}${(100/leverage).toFixed(2)}% ${direction==='high'?'하락':'상승'}`;
  const overBalance = validAmount && amount+fee>engine.state.cash+1e-7;
  $('#order-error').textContent = !validAmount?'최소 1원부터 투자할 수 있어요.':overBalance?'수수료를 포함한 잔액이 부족해요. 최대 버튼을 눌러보세요.':'';
  $('#place-order').disabled = !validAmount||overBalance||engine.state.status!=='playing';
  $('#leverage-value').innerHTML = `${leverage}<span>×</span>`;
  $('#leverage').style.setProperty('--range-progress',`${(leverage-1)/99*100}%`);
  for (const button of $$('[data-leverage]')) button.classList.toggle('active',Number(button.dataset.leverage)===leverage);
  const warning = leverage>=20;
  $('#leverage-hint').classList.toggle('warning',warning);
  $('#leverage-hint span').textContent = leverage>=50?`${(100/leverage).toFixed(1)}%의 반대 움직임에도 강제 청산될 수 있어요.`:leverage>=20?'높은 레버리지일수록 손실도 빠르게 커집니다.':leverage>=5?`가격 변동의 ${leverage}배만큼 손익이 움직입니다.`:'내 속도로, 차분하게 시작하세요.';
}

function setDirection(value) {
  direction=value;
  $$('[data-direction]').forEach(button=>button.classList.toggle('active',button.dataset.direction===value));
  $('#direction-description').textContent = value==='high'?'가격이 오를수록 수익이 발생해요.':'가격이 내려갈수록 수익이 발생해요.';
  $('#place-order').className=`place-order ${value}`;
  $('#place-order').innerHTML=`${icon(value==='high'?'arrow':'down')}<span>${value.toUpperCase()} 포지션 열기</span><span class="order-button-arrow">${value==='high'?'↗':'↘'}</span>`;
  updateOrder();
}

function updateAccount() {
  const state=engine.state;
  $('#header-equity').textContent=money(engine.equity());
  $('#account-net').textContent=money(engine.netEquity());
  const pnl=state.positions.reduce((total,p)=>total+engine.positionPnl(p),0);
  $('#account-pnl').textContent=signedMoney(pnl);
  $('#account-pnl').className=pnl===0?'':colorClass(pnl);
  $('#account-margin').textContent=money(state.positions.reduce((total,p)=>total+p.amount,0));
  $('#account-debt').textContent=money(state.loan?.amount||0);
  $('#account-progress-bar').style.width=`${Math.max(0,Math.min(100,engine.netEquity()/1000))}%`;
  $('#position-count').textContent=state.positions.length;
  $('#history-count').textContent=state.history.length;
  $('#close-all').hidden=!state.positions.length||portfolioTab!=='positions';
  $('#debt-banner').hidden=!state.loan||state.status==='gameover';
  if(state.loan){
    const seconds=Math.max(0,Math.ceil((state.loan.dueAt-Date.now())/1000));
    $('#debt-clock').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
    $('#debt-banner').classList.toggle('urgent',seconds<=60);
    $('#repay-button').disabled=state.cash<state.loan.amount;
    $('#repay-button').title=state.cash<state.loan.amount?'보유 포지션을 청산하여 현금 10만 원을 확보하세요.':'대출금 10만 원 상환';
  }
}

function updatePortfolio(force=false) {
  const state=engine.state;
  const rows=portfolioTab==='history'?state.history:state.positions;
  const signature=`${portfolioTab}:${rows.map(p=>p.id).join(',')}`;
  if(portfolioTab==='overview'){
    const realized=engine.netEquity()-INITIAL_CASH-state.positions.reduce((sum,p)=>sum+engine.positionPnl(p),0);
    $('#portfolio-content').innerHTML=`<div class="overview-grid"><div><span>누적 실현 손익</span><strong class="${colorClass(realized)}">${signedMoney(realized)}</strong></div><div><span>최고 순자산</span><strong>${money(state.peakEquity)}</strong></div><div><span>청산한 거래</span><strong>${state.trades}<small> 회</small></strong></div><div><span>승률</span><strong>${state.trades?(state.wins/state.trades*100).toFixed(1):'0'}<small>%</small></strong></div></div>`;
    portfolioSignature=signature; return;
  }
  if(force||signature!==portfolioSignature){
    portfolioSignature=signature;
    if(!rows.length){
      $('#portfolio-content').innerHTML=`<div class="portfolio-empty"><div class="empty-icon">${icon(portfolioTab==='positions'?'wallet':'clock')}</div><div><h3>${portfolioTab==='positions'?'아직 열려 있는 포지션이 없습니다':'당신의 거래 기록이 쌓일 공간'}</h3><p>${portfolioTab==='positions'?'첫 번째 기회를 발견했다면, <span>지금 포지션을 열어보세요.</span>':'포지션을 청산하면 수익과 손실을 여기서 확인할 수 있어요.'}</p></div></div>`;
      return;
    }
    const history=portfolioTab==='history';
    $('#portfolio-content').innerHTML=`<div class="positions-wrapper"><table class="positions-table"><thead><tr><th>종목</th><th>방향</th><th>증거금</th><th>진입가</th><th>${history?'청산가':'현재가'}</th><th>${history?'실현 손익':'평가 손익'}</th><th>${history?'종료':'관리'}</th></tr></thead><tbody>${rows.map(p=>{
      const stock=STOCK_BY_ID[p.stockId];
      return `<tr data-position="${p.id}"><td class="position-name">${escapeHTML(stock.name)}<small>${stock.ticker}</small></td><td><span class="position-direction ${p.direction}">${p.direction.toUpperCase()}</span><span class="position-leverage">${p.leverage}×</span></td><td>${money(p.amount)}</td><td>${nativePrice(p.entryPrice,stock)}</td><td data-current></td><td class="pnl-cell" data-pnl></td><td>${history?`<span class="${p.type==='liquidation'?'down':'muted'}">${p.type==='liquidation'?'강제 청산':p.reason==='deadline'?'만기 정산':'청산 완료'}</span>`:`<button class="close-position" data-close-position="${p.id}">청산</button>`}</td></tr>`;
    }).join('')}</tbody></table></div>`;
  }
  for(const p of rows){
    const row=$(`[data-position="${CSS.escape(p.id)}"]`);
    if(!row)continue;
    const stock=STOCK_BY_ID[p.stockId];
    const pnl=portfolioTab==='history'?p.pnl:engine.positionPnl(p);
    row.querySelector('[data-current]').textContent=nativePrice(portfolioTab==='history'?p.exitPrice:engine.markets[p.stockId].price,stock);
    const cell=row.querySelector('[data-pnl]');
    cell.className=`pnl-cell ${colorClass(pnl)}`;
    cell.innerHTML=`<strong>${signedMoney(pnl)}</strong><small>${percent(pnl/p.amount*100)}</small>`;
  }
}

function processEvents(events){
  for(const event of events){
    if(event.type==='news')$('#market-news').textContent=`[가상 뉴스] ${event.message}`;
    else if(event.type==='liquidation'){toast(event.message,'error');playSound('error');}
    else if(event.type==='repay')toast(event.message,'success');
    else if(event.type==='borrow')toast(event.message);
    else if(event.type==='gameover')$('#gameover-reason').textContent=event.message;
  }
}

function syncGameState(){
  const state=engine.state;
  if(state.status===lastStatus)return;
  lastStatus=state.status;
  if(state.status==='bankrupt'){
    $$('dialog[open]').forEach(dialog=>dialog.close());
    $('#loan-dialog').showModal();
    save();
  }else if(state.status==='gameover'){
    $$('dialog[open]').forEach(dialog=>dialog.close());
    $('#gameover-screen').hidden=false;
    $('#gameover-peak').textContent=money(state.peakEquity);
    $('#gameover-trades').textContent=`${state.trades}회`;
    gameoverTime=state.endedAt||Date.now();
    if(state.gameoverReason)$('#gameover-reason').textContent=state.gameoverReason;
    const elapsed=Math.max(0,Math.floor((gameoverTime-state.startedAt)/1000));
    $('#gameover-time').textContent=`${Math.floor(elapsed/60)}분 ${elapsed%60}초`;
    $('#restart-game').focus();
    playSound('error');
    save();
  }else{
    if($('#loan-dialog').open)$('#loan-dialog').close();
    $('#gameover-screen').hidden=true;
  }
}

function render(){
  updateStockPrices();updateInstrument();updateChart();updateIndices();updateAccount();updateOrder();updatePortfolio();syncGameState();
  const time=timeFormat.format(Date.now());
  $('#footer-clock').textContent=`${time} KST`;
  $('#chart-time').textContent=`${time} (UTC+9)`;
}

function action(callback){
  try{callback();processEvents(engine.tick(Date.now()));render();save();}
  catch(error){toast(error.message||'처리하지 못했습니다. 다시 시도해 주세요.','error');render();save();}
}

function resetGame(){
  $$('dialog[open]').forEach(dialog=>dialog.close());
  engine=new TradingEngine();engine.volatilityMultiplier=preferences.volatility;
  lastStatus=null;gameoverTime=null;portfolioSignature='';
  $('#order-amount').value='10000';leverage=1;$('#leverage').value='1';
  $('#gameover-reason').textContent='시장은 계속됩니다. 당신의 다음 도전을 기다립니다.';
  chart.resetView();render();save();toast('새로운 시작. 100,000원이 입금되었습니다.','success');
}

$('#stock-search').addEventListener('input',refreshStockList);
$('#stock-list').addEventListener('click',event=>{const row=event.target.closest('[data-stock]');if(row)selectStock(row.dataset.stock);});
$$('[data-market]').forEach(button=>button.addEventListener('click',()=>{marketFilter=button.dataset.market;$$('[data-market]').forEach(item=>item.classList.toggle('active',item===button));refreshStockList();}));
$('#favorites-filter').addEventListener('click',()=>{favoritesOnly=!favoritesOnly;$('#favorites-filter').classList.toggle('favorite-active',favoritesOnly);$('#favorites-filter').setAttribute('aria-pressed',String(favoritesOnly));refreshStockList();});
$('#selected-favorite').addEventListener('click',()=>{const index=preferences.favorites.indexOf(selected);if(index>=0)preferences.favorites.splice(index,1);else preferences.favorites.push(selected);updateInstrument();if(favoritesOnly)refreshStockList();save();});
$$('[data-interval]').forEach(button=>{button.classList.toggle('active',Number(button.dataset.interval)===preferences.interval);button.addEventListener('click',()=>{preferences.interval=Number(button.dataset.interval);$$('[data-interval]').forEach(item=>item.classList.toggle('active',item===button));chart.resetView();updateChart();save();});});
$('#chart-type').addEventListener('click',()=>{preferences.chartType=preferences.chartType==='candles'?'line':'candles';$('#chart-type').innerHTML=icon(preferences.chartType==='candles'?'candle':'chart');$('#chart-type').setAttribute('aria-label',preferences.chartType==='candles'?'선 차트로 전환':'캔들 차트로 전환');updateChart();save();});
$('#chart-type').innerHTML=icon(preferences.chartType==='candles'?'candle':'chart');
$('#chart-type').setAttribute('aria-label',preferences.chartType==='candles'?'선 차트로 전환':'캔들 차트로 전환');
$('#ma-toggle').classList.toggle('active',preferences.showMA);
$('#ma-toggle').setAttribute('aria-pressed',String(preferences.showMA));
$('#ma-toggle').addEventListener('click',()=>{preferences.showMA=!preferences.showMA;$('#ma-toggle').classList.toggle('active',preferences.showMA);$('#ma-toggle').setAttribute('aria-pressed',String(preferences.showMA));updateChart();save();});
$('#chart-reset').addEventListener('click',()=>chart.resetView());
$('#chart-expand').addEventListener('click',()=>{const expanded=$('#chart-panel').classList.toggle('expanded');$('#chart-expand').setAttribute('aria-label',expanded?'차트 축소':'차트 확대');});
$$('[data-direction]').forEach(button=>button.addEventListener('click',()=>setDirection(button.dataset.direction)));
$('#order-amount').min=String(MIN_MARGIN);$('#order-amount').step='0.01';
$('#order-amount').addEventListener('input',updateOrder);
$$('[data-amount]').forEach(button=>button.addEventListener('click',()=>{$('#order-amount').value=button.dataset.amount;updateOrder();}));
$$('[data-percent]').forEach(button=>button.addEventListener('click',()=>{$('#order-amount').value=String(maxMargin(Number(button.dataset.percent)));updateOrder();}));
$('#leverage').addEventListener('input',()=>{leverage=Number($('#leverage').value);updateOrder();});
$$('[data-leverage]').forEach(button=>button.addEventListener('click',()=>{leverage=Number(button.dataset.leverage);$('#leverage').value=String(leverage);updateOrder();}));
$('#place-order').addEventListener('click',()=>action(()=>{const p=engine.openPosition({stockId:selected,direction,amount:Number($('#order-amount').value),leverage});toast(`${STOCK_BY_ID[selected].name} ${direction.toUpperCase()} ${leverage}× · ${money(p.amount)} 체결`,'success');playSound();}));
$$('[data-tab]').forEach(button=>button.addEventListener('click',()=>{portfolioTab=button.dataset.tab;$$('[data-tab]').forEach(item=>item.classList.toggle('active',item===button));updatePortfolio(true);updateAccount();}));
$('#portfolio-content').addEventListener('click',event=>{const button=event.target.closest('[data-close-position]');if(button)action(()=>{const trade=engine.closePosition(button.dataset.closePosition);toast(`${STOCK_BY_ID[trade.stockId].name} 청산 · ${signedMoney(trade.pnl)}`,trade.pnl>=0?'success':'');playSound();});});
$('#close-all').addEventListener('click',()=>action(()=>{const trades=engine.closeAll();toast(`${trades.length}개 포지션을 모두 청산했습니다.`,'success');}));
$('#repay-button').addEventListener('click',()=>action(()=>engine.repay()));
$('#borrow-button').addEventListener('click',()=>action(()=>{engine.borrow();$('#order-amount').value='10000';}));
$('#decline-loan').addEventListener('click',()=>action(()=>engine.declineLoan()));
$('#loan-dialog').addEventListener('cancel',event=>event.preventDefault());
$('#help-button').addEventListener('click',()=>$('#help-dialog').showModal());
$('#settings-button').addEventListener('click',()=>$('#settings-dialog').showModal());
$$('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
$('#volatility-setting').value=String(preferences.volatility);
$('#volume-setting').checked=preferences.showVolume;
$('#sound-setting').checked=preferences.sound;
$('#volatility-setting').addEventListener('change',()=>{preferences.volatility=Number($('#volatility-setting').value);engine.volatilityMultiplier=preferences.volatility;save();toast('시장 변동성을 변경했습니다.');});
$('#volume-setting').addEventListener('change',()=>{preferences.showVolume=$('#volume-setting').checked;updateChart();save();});
$('#sound-setting').addEventListener('change',()=>{preferences.sound=$('#sound-setting').checked;playSound();save();});
$('#reset-request').addEventListener('click',()=>{$('#settings-dialog').close();$('#reset-dialog').showModal();});
$('#confirm-reset').addEventListener('click',resetGame);
$('#restart-game').addEventListener('click',resetGame);
$('#nav-portfolio').addEventListener('click',()=>{if(!window.matchMedia('(min-width: 901px)').matches)$('#portfolio-panel').scrollIntoView({behavior:'smooth',block:'center'});else $('.portfolio-tabs .active').focus({preventScroll:true});$('#nav-portfolio').classList.add('active');$('#nav-trade').classList.remove('active');});
$('#nav-trade').addEventListener('click',()=>{if(!window.matchMedia('(min-width: 901px)').matches)$('#chart-panel').scrollIntoView({behavior:'smooth',block:'center'});else $('.intervals .active').focus({preventScroll:true});$('#nav-trade').classList.add('active');$('#nav-portfolio').classList.remove('active');});
document.addEventListener('keydown',event=>{if(event.key==='Escape')$('#chart-panel').classList.remove('expanded');if(event.key==='/'&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)&&!$('dialog[open]')&&engine.state.status==='playing'){event.preventDefault();$('#stock-search').focus();}});
window.addEventListener('pagehide',save);
document.addEventListener('visibilitychange',()=>{if(document.hidden)save();else{processEvents(engine.tick(Date.now()));render();save();}});

refreshStockList();
processEvents(engine.tick(Date.now()));
render();
if(engine.restoreWarning)toast(engine.restoreWarning,'error');
if(!storageAvailable)toast('브라우저 저장소를 사용할 수 없어 현재 세션에서만 유지됩니다.','error');
setInterval(()=>{processEvents(engine.tick(Date.now()));render();if(Date.now()-lastSave>=5000)save();},1000);
