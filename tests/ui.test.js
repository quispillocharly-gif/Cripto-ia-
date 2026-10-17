'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const page=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const i=page.indexOf("<script>\n'use strict';"),j=page.indexOf('</script>',i);
assert(i>=0&&j>i,'Main inline dashboard script exists');
const nodes=new Map();
function node(id){
  if(!nodes.has(id))nodes.set(id,{
    id,innerHTML:'',textContent:'',style:{},hidden:false,disabled:false,value:'',
    classList:{toggle(){},add(){},remove(){}},
    onclick:null
  });
  return nodes.get(id);
}
const now=new Date().toISOString();
const demo=(kind,side,status)=>({
  id:kind+':BTCUSDT',kind,symbol:'BTC',name:'BTCUSDT',chain:'Binance '+kind,
  side,status,score:82,price:100,entry:100,stop:side==='sell'?102:98,tp1:side==='sell'?97:103,tp2:side==='sell'?95:105,
  updatedAt:now,why:['Confirmación sintética para prueba'],risks:[],
  quoteAsset:'USDT',fundingRatePct:0.01,riskPct:2,
  url:'https://www.binance.com/en/futures/BTCUSDT'
});
const snapshot={
  scanFinished:now,scans:13,
  spot:{data:[demo('spot','buy','signal')],source:'Spot',error:null,updatedAt:now,coverage:{catalogueAssets:1,cataloguePairs:1,detailed:1,stale:0,apiErrors:0}},
  dex:{data:[],source:'DEX',error:null,updatedAt:now},
  futures:{data:[],source:'Binance Futures',error:'HTTP 451',updatedAt:null,coverage:null},
  history:[],futuresHistory:[],futuresPerformance:{LONG:{},SHORT:{}},events:[],
  intelligence:{legacy:{sample:2,wins:1,losses:1,observedHitRate:50},current:{sample:0}}
};
const browserData={data:[demo('futures','sell','signal')],coverage:{
  catalogueAssets:400,catalogueContracts:500,selectedForDetail:1,
  detailed:1,stale:0,apiErrors:0,partial:true
}};
const context={
  window:{CriptoFutures:{scanFutures:async()=>browserData}},
  document:{getElementById:node,hidden:false},
  fetch:async()=>({ok:true,json:async()=>snapshot}),
  AbortSignal,Date,console,Promise,URL,
  setInterval:()=>1,
  localStorage:{setItem(){},getItem(){return null;}}
};
vm.runInNewContext(page.slice(i+8,j),context,{timeout:1000});
(async()=>{
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(node('statTotal').textContent,1,'Spot tab loads its own count');
  assert.match(node('cards').innerHTML,/BTC/,'Spot cards rendered');
  assert.equal(typeof node('tabFutures').onclick,'function','Futures tab is clickable');
  node('tabFutures').onclick();
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(node('statTotal').textContent,1,'Browser Futures loads one contract');
  assert.match(node('cards').innerHTML,/BINANCE FUTURES|GATE.IO FUTURES/,'Futures source badge visible');
  assert.match(node('cards').innerHTML,/SHORT|VENTA/,'Futures short signalled');
  assert.match(node('futuresMode').textContent,/celular|dispositivo/i,'Explicit browser-only mode warning');
  assert.equal(node('futuresNotice').style.display,'block');
  assert.match(node('historyTitle').textContent,/Futures/,'Futures statistics independent');
  node('tabSpot').onclick();
  assert.equal(node('futuresNotice').style.display,'none');
  assert.equal(node('statTotal').textContent,1);
  console.log('Mobile dashboard smoke tests: PASS (Spot → Futures SHORT → Spot)');
})().catch(e=>{console.error(e);process.exitCode=1;});
