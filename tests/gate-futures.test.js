'use strict';
const assert=require('node:assert/strict');
const {evaluateGate,auditGateFutures}=require('../gate-futures');
const now=Date.now();
function synthetic(rising,at=now){
 const bars=[];
 for(let i=0;i<110;i++){
  const c=rising?100+i*.1:120-i*.1;
  const o=rising?c-.085:c+.085;
  bars.push({t:Math.floor((at-(110-i)*300000)/1000),o:String(o),c:String(c),
   h:String(Math.max(o,c)+.015),l:String(Math.min(o,c)-.015),v:'10000',sum:i===109?'1800000':'900000'});
 }
 return bars;
}
function quote(bars){
 const c=Number(bars[bars.length-1].c);
 return {contract:'TEST_USDT',last:String(c),
  volume_24h_quote:'54000000',change_percentage:'2.5',
  highest_bid:String(c*.99996),lowest_ask:String(c*1.00004),funding_rate:'0.0001'};
}
const up=synthetic(true),down=synthetic(false);
const long=evaluateGate(up,quote(up),now),short=evaluateGate(down,quote(down),now);
assert(long&&short,'Both trends should be analyzable');
assert.equal(long.side,'buy');assert.equal(short.side,'sell');
assert.equal(long.marketProvider,'Gate.io');assert.equal(short.marketProvider,'Gate.io');
assert(long.stop<long.entry&&long.tp1>long.entry&&long.tp2>long.tp1);
assert(short.stop>short.entry&&short.tp1<short.entry&&short.tp2<short.tp1);
assert.equal(evaluateGate(synthetic(true,now-3600000),quote(up),now),null);
const highFunding=evaluateGate(up,{...quote(up),funding_rate:'0.005'},now);
assert(highFunding&&highFunding.status!=='signal','Extreme funding blocks a signal');
(async()=>{
 assert.deepEqual(await auditGateFutures([]),[]);
 console.log('Gate Futures tests: PASS (real-market schema, LONG, SHORT, stale candles, funding, empty audit)');
})().catch(e=>{console.error(e);process.exitCode=1;});
