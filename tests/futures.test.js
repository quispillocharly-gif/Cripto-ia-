'use strict';
const assert=require('node:assert/strict');
const {analyzeFuturesPair,appendFuturesSignals,auditFutures,futuresStats}=require('../futures');
function candles(up,now=Date.now()){
 const arr=[];
 for(let i=0;i<110;i++){
  const close=up?100+i*0.12:120-i*0.12;
  const open=up?close-.07:close+.07,high=Math.max(open,close)+.015,low=Math.min(open,close)-.015;
  const at=now-(110-i)*300000;
  const q=1000000;
  arr.push([at,String(open),String(high),String(low),String(close),'10000',at+299999,String(q),'100',
    '4500',String(up?q*.68:q*.32),'0']);
 }
 return arr;
}
const now=Date.now();
const books={bidPrice:'111.000',askPrice:'111.003'};
const price=(arr)=>arr[arr.length-1][4];
const ticker=(arr)=>({symbol:'TESTUSDT',baseAsset:'TEST',quoteAsset:'USDT',
   lastPrice:price(arr),quoteVolume:'75000000',priceChangePercent:'2.1'});
const fund={lastFundingRate:'0.0001'};
const up=candles(true,now),down=candles(false,now);
const a=analyzeFuturesPair(up,ticker(up),fund,books,now);
assert(a,'Trend-up data should be evaluated');
assert.equal(a.kind,'futures');
assert.equal(a.side,'buy');
assert(a.stop<a.entry && a.tp1>a.entry && a.tp2>a.tp1,'Long levels should be consistent');
const downBook={bidPrice:price(down),askPrice:String(Number(price(down))*1.00001)};
const b=analyzeFuturesPair(down,ticker(down),fund,downBook,now);
assert(b,'Trend-down data should be evaluated');
assert.equal(b.side,'sell');
assert(b.stop>b.entry && b.tp1<b.entry && b.tp2<b.tp1,'Short levels should be consistent');
const stale=candles(true,now-3600000);
assert.equal(analyzeFuturesPair(stale,ticker(stale),fund,books,now),null,
 'Stale 5m candles must never produce a signal');
const extreme=analyzeFuturesPair(up,ticker(up),{lastFundingRate:'0.003'},books,now);
assert(extreme && extreme.status!=='signal','Extreme funding must prevent a signal');
const row={...a,status:'signal',signalKey:'futures:TESTUSDT:buy:1'};
const hist=appendFuturesSignals([], [row,row]);
assert.equal(hist.length,1,'Do not duplicate one signal');
assert.equal(hist[0].direction,'LONG');
assert.equal(futuresStats(hist).LONG.pending,1);
(async()=>{
  assert.deepEqual(await auditFutures([]),[]);
  console.log('Futures module tests: PASS (LONG, SHORT, stale, funding, deduplication, independent stats)');
})().catch(e=>{console.error(e);process.exitCode=1;});
