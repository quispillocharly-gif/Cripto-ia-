'use strict';
// Independent Binance USDⓈ-M Futures scanner; never sends trade orders.
// Market-data APIs only. Fail closed if Futures is blocked or unavailable.
const API = 'https://fapi.binance.com/fapi/v1';
const MAX_HISTORY = 250;
const num = x => Number(x) || 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();

async function getJson(url, timeout = 20000) {
  for (let n = 0; n < 2; n++) {
    const response = await fetch(url, {
      headers: {accept: 'application/json', 'user-agent': 'CriptoIARadar-Futures/1.0'},
      signal: AbortSignal.timeout(timeout)
    });
    if (response.ok) return response.json();
    if (response.status === 451 || response.status === 403)
      throw Error('Binance Futures no disponible desde este servidor (HTTP ' + response.status + ', restricción regional o acceso denegado)');
    if ((response.status === 418 || response.status === 429 || response.status >= 500) && n === 0) {
      const seconds = Number(response.headers.get('retry-after'));
      await wait(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 25000) : 3500);
      continue;
    }
    throw Error('Fuente Binance Futures HTTP ' + response.status);
  }
  throw Error('No se recibió información de Binance Futures');
}
function ema(prices, period) {
  const k = 2/(period+1);
  let value = prices[0];
  return prices.map(p => value = p*k + value*(1-k));
}
function rsi(values, period = 14) {
  if (values.length < period+2) return 50;
  let up = 0, down = 0;
  for (let i=1; i<=period; i++) {
    const d=values[i]-values[i-1];up+=Math.max(d,0);down+=Math.max(-d,0);
  }
  up/=period;down/=period;
  for (let i=period+1;i<values.length;i++) {
    const d=values[i]-values[i-1];
    up=(up*(period-1)+Math.max(d,0))/period;
    down=(down*(period-1)+Math.max(-d,0))/period;
  }
  return down===0?(up?100:50):100-100/(1+up/down);
}
function atr(bars, period = 14) {
  if (bars.length<period+2) return 0;
  let value=0;
  for (let i=1;i<=period;i++)
    value+=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));
  value/=period;
  for (let i=period+1;i<bars.length;i++) {
    const tr=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));
    value=(value*(period-1)+tr)/period;
  }
  return value;
}
function analyzeFuturesPair(raw, ticker, funding, book, nowMs = Date.now()) {
  if (!Array.isArray(raw)) return null;
  const bars=raw.map(b=>({
    time:num(b[6]), open:num(b[1]), high:num(b[2]), low:num(b[3]),close:num(b[4]),
    volume:num(b[5]),quoteVolume:num(b[7]),takerBuyQuote:num(b[10])
  })).filter(b=>b.time<=nowMs-200 && b.open>0 && b.high>=b.low && b.close>0);
  if (bars.length<75) return null;
  const last=bars.at(-1);
  if (nowMs-last.time>16*60000 || last.time>nowMs) return null;
  const closes=bars.map(b=>b.close);
  const e20=ema(closes,20), e50=ema(closes,50), relativeStrength=rsi(closes), volatility=atr(bars);
  if(!volatility) return null;
  const older=bars.slice(0,-1);
  const volumeMean=older.slice(-20).reduce((v,b)=>v+b.quoteVolume,0)/20;
  const vRatio=volumeMean>0?last.quoteVolume/volumeMean:0;
  const last3=bars.slice(-3);
  const recentVol=last3.reduce((a,b)=>a+b.quoteVolume,0);
  const buyerShare=recentVol>0?last3.reduce((a,b)=>a+b.takerBuyQuote,0)/recentVol:null;
  const range=Math.max(1e-12,last.high-last.low);
  const closeRank=clamp((last.close-last.low)/range,0,1);
  const upperWick=clamp((last.high-Math.max(last.close,last.open))/range,0,1);
  const lowerWick=clamp((Math.min(last.close,last.open)-last.low)/range,0,1);
  const momentum=100*(last.close/bars.at(-4).close-1);
  const slope=100*(e20.at(-1)/e20.at(-5)-1);
  const breakout=last.close>Math.max(...older.slice(-20).map(b=>b.high));
  const breakdown=last.close<Math.min(...older.slice(-20).map(b=>b.low));
  const fundingRate = funding && Number.isFinite(Number(funding.lastFundingRate)) ?
    Number(funding.lastFundingRate)*100 : null;
  const ask=num(book?.askPrice),bid=num(book?.bidPrice);
  const spread=bid>0 && ask>bid ? 100*(ask-bid)/((ask+bid)/2) : null;
  const quote24=num(ticker.quoteVolume);
  const deviation=Math.abs(num(ticker.lastPrice)-last.close)/last.close;
  const blocked=quote24<1000000||deviation>.025||spread===null||spread>.18||
    fundingRate===null||Math.abs(fundingRate)>.13||buyerShare===null;
  const priceRisk=clamp(Math.max(volatility*1.5,last.close*.0075),last.close*.006,last.close*.045);
  const buyerPct=buyerShare===null?null:+(buyerShare*100).toFixed(1);
  const commonRisks=[];
  if(quote24<1000000)commonRisks.push('Volumen 24 h insuficiente');
  if(deviation>.025)commonRisks.push('Precio/velas inconsistentes');
  if(spread===null)commonRisks.push('Spread desconocido');
  else if(spread>.18)commonRisks.push('Spread elevado');
  if(fundingRate===null)commonRisks.push('Funding no disponible');
  else if(Math.abs(fundingRate)>.13)commonRisks.push('Funding extremo');
  const longWhy=[],shortWhy=[],longRisks=[],shortRisks=[];
  let longs=12,shorts=12;
  if(e20.at(-1)>e50.at(-1)&&last.close>e20.at(-1)){longs+=23;longWhy.push('Tendencia alcista EMA20/50');}
  else longs-=11;
  if(e20.at(-1)<e50.at(-1)&&last.close<e20.at(-1)){shorts+=23;shortWhy.push('Tendencia bajista EMA20/50');}
  else shorts-=11;
  if(slope>.045) longs+=10;else if(slope<0)longs-=7;
  if(slope<-.045) shorts+=10;else if(slope>0)shorts-=7;
  if(relativeStrength>=49 && relativeStrength<=66){longs+=14;longWhy.push('RSI con margen alcista');}
  else if(relativeStrength>72){longs-=20;longRisks.push('Sobrecompra');}
  if(relativeStrength>=33&&relativeStrength<=51){shorts+=14;shortWhy.push('RSI con margen bajista');}
  else if(relativeStrength<28){shorts-=20;shortRisks.push('Sobreventa');}
  if(vRatio>=1.5){longs+=17;shorts+=17;longWhy.push('Volumen acelerando');shortWhy.push('Volumen acelerando');}
  else if(vRatio>=1.12){longs+=8;shorts+=8;}else{longs-=8;shorts-=8;}
  if(breakout){longs+=16;longWhy.push('Ruptura de máximos 20 velas');}
  if(breakdown){shorts+=16;shortWhy.push('Ruptura de mínimos 20 velas');}
  if(momentum>.12&&momentum<2){longs+=8;}
  else if(momentum>3){longs-=19;longRisks.push('Subida extendida');}
  if(momentum<-.12&&momentum> -2){shorts+=8;}
  else if(momentum< -3){shorts-=19;shortRisks.push('Caída extendida');}
  if(buyerShare!==null){
    if(buyerShare>=.54){longs+=15;longWhy.push('Compras agresivas '+buyerPct+'%');shorts-=16;}
    else if(buyerShare<=.46){shorts+=15;shortWhy.push('Ventas agresivas '+(100-buyerPct).toFixed(1)+'%');longs-=16;}
  }
  if(closeRank>=.7 && upperWick<=.25){longs+=8;longWhy.push('Cierre alcista firme');}
  else if(closeRank<.5){longs-=12;longRisks.push('Cierre débil');}
  if(closeRank<=.3 && lowerWick<=.25){shorts+=8;shortWhy.push('Cierre bajista firme');}
  else if(closeRank>.5){shorts-=12;shortRisks.push('Rebote en vela');}
  // Extreme funding can mark crowded positioning even when it is not an absolute block.
  if(fundingRate!==null && fundingRate>.065){longs-=8;longRisks.push('Longs posiblemente saturados (funding)');}
  if(fundingRate!==null && fundingRate<-.065){shorts-=8;shortRisks.push('Shorts posiblemente saturados (funding)');}
  const longScore=clamp(Math.round(longs),0,100),shortScore=clamp(Math.round(shorts),0,100);
  const longOK=!blocked && longScore>=79 && breakout && vRatio>=1.15 &&
    buyerShare>=.53 && closeRank>=.65 && upperWick<=.3 && relativeStrength<69 && momentum<2.8;
  const shortOK=!blocked && shortScore>=79 && breakdown && vRatio>=1.15 &&
    buyerShare<=.47 && closeRank<=.35 && lowerWick<=.3 && relativeStrength>29 && momentum> -2.8;
  const side=longOK?'buy':shortOK?'sell':longScore>=shortScore?'buy':'sell';
  const live=side==='buy'?longOK:shortOK;
  const score=side==='buy'?longScore:shortScore;
  const direction=side==='buy'?'LONG':'SHORT';
  const entry=last.close;
  const stop=side==='buy'?entry-priceRisk:entry+priceRisk;
  const tp1=side==='buy'?entry+1.5*priceRisk:Math.max(0,entry-1.5*priceRisk);
  const tp2=side==='buy'?entry+2.3*priceRisk:Math.max(0,entry-2.3*priceRisk);
  const why=side==='buy'?longWhy:shortWhy;
  const risks=[...commonRisks,...(side==='buy'?longRisks:shortRisks)];
  if(!live && !blocked && score>=55)risks.push('Esperando confirmación LONG/SHORT');
  const status=live?'signal':(!blocked&&score>=54?'watch':'reject');
  const symbol=String(ticker.symbol);
  const baseAsset=ticker.baseAsset||symbol.replace(/USDT$|USDC$/,'');
  const quoteAsset=ticker.quoteAsset||'USDT';
  return {
    id:'futures:'+symbol,kind:'futures',name:symbol,symbol:baseAsset,
    chain:'Binance USDⓈ-M PERPETUAL',quoteAsset,contractType:'PERPETUAL',
    side,direction,score,status,why,risks,
    price:num(ticker.lastPrice)||entry,entry,stop,tp1,tp2,
    riskPct:+(100*priceRisk/entry).toFixed(2),
    volume:quote24,change5:+momentum.toFixed(3),change1:num(ticker.priceChangePercent),
    volRatio:+vRatio.toFixed(2),rsi:+relativeStrength.toFixed(1),
    takerBuyPct:buyerPct,spreadPct:spread===null?null:+spread.toFixed(3),
    fundingRatePct:fundingRate===null?null:+fundingRate.toFixed(4),
    origin:'Binance USDⓈ-M Futures',setupVersion:'FUTURES_FLOW_1',detailLevel:'ohlc',
    candleClosedAt:new Date(last.time).toISOString(),updatedAt:iso(),
    signalKey:'futures:'+symbol+':'+side+':'+last.time,
    url:'https://www.binance.com/en/futures/'+encodeURIComponent(symbol)
  };
}
function fallback(t,reason) {
  return {
    id:'futures:'+t.symbol,kind:'futures',name:t.symbol,
    symbol:t.baseAsset||t.symbol,quoteAsset:t.quoteAsset||'USDT',
    chain:'Binance USDⓈ-M PERPETUAL',side:'none',direction:'—',
    price:num(t.lastPrice),entry:null,stop:null,tp1:null,tp2:null,
    score:null,status:'catalog',volume:num(t.quoteVolume),
    change1:num(t.priceChangePercent),change5:null,detailLevel:'24h',
    fundingRatePct:null,why:['Contrato perpetuo listado'],risks:[reason],
    updatedAt:iso(),origin:'Binance USDⓈ-M Futures',
    url:'https://www.binance.com/en/futures/'+encodeURIComponent(t.symbol)
  };
}
async function scanFutures({limit=null}={}) {
  const [exchange,tickers,books,premiums]=await Promise.all([
    getJson(API+'/exchangeInfo',22000),
    getJson(API+'/ticker/24hr',22000),
    getJson(API+'/ticker/bookTicker',22000),
    getJson(API+'/premiumIndex',22000)
  ]);
  if(!Array.isArray(exchange?.symbols)||!Array.isArray(tickers)||
     !Array.isArray(books)||!Array.isArray(premiums))
    throw Error('Listado Binance Futures incompleto; sin señales nuevas');
  const all=exchange.symbols.filter(s=>s.contractType==='PERPETUAL'&&
    s.status==='TRADING'&&['USDT','USDC'].includes(s.quoteAsset));
  const bookMap=new Map(books.map(t=>[t.symbol,t])),premiumMap=new Map(premiums.map(t=>[t.symbol,t]));
  const tickerMap=new Map(tickers.map(t=>[t.symbol,t]));
  const preferred=new Map();
  for(const item of all) {
    const ticker=tickerMap.get(item.symbol);
    if(!ticker || num(ticker.lastPrice)<=0)continue;
    const t={...ticker,baseAsset:item.baseAsset,quoteAsset:item.quoteAsset};
    const old=preferred.get(item.baseAsset);
    if(!old || t.quoteAsset==='USDT'&&old.quoteAsset!=='USDT' ||
       t.quoteAsset===old.quoteAsset&&num(t.quoteVolume)>num(old.quoteVolume))
      preferred.set(item.baseAsset,t);
  }
  const allItems=[...preferred.values()].sort((a,b)=>a.baseAsset.localeCompare(b.baseAsset));
  const items=Number.isInteger(limit)&&limit>0?allItems.slice().sort((a,b)=>num(b.quoteVolume)-num(a.quoteVolume)).slice(0,Math.min(limit,80)):allItems;
  if(!items.length)throw Error('Binance Futures no devolvió contratos perpetuos negociables');
  const rows=[];
  let detailed=0,stale=0,apiErrors=0;
  for(let i=0;i<items.length;i+=9){
    const group=items.slice(i,i+9);
    const responses=await Promise.allSettled(group.map(t=>
      getJson(API+'/klines?symbol='+encodeURIComponent(t.symbol)+'&interval=5m&limit=110',17000)));
    for(let j=0;j<group.length;j++){
      const t=group[j],result=responses[j];
      if(result.status==='fulfilled'){
        const computed=analyzeFuturesPair(result.value,t,premiumMap.get(t.symbol),bookMap.get(t.symbol));
        if(computed){rows.push(computed);detailed++;}
        else{rows.push(fallback(t,'Velas incompletas/antiguas; sin señal'));stale++;}
      }else {
        rows.push(fallback(t,'API no confirmó velas; sin señal'));apiErrors++;
      }
    }
    if(i+9<items.length)await wait(250);
  }
  const ranks={signal:0,watch:1,reject:2,catalog:3};
  rows.sort((a,b)=>(ranks[a.status]??4)-(ranks[b.status]??4)||
    (b.score||0)-(a.score||0));
  const coverage={
    catalogueContracts:all.length,catalogueAssets:allItems.length,selectedForDetail:items.length,detailed,stale,apiErrors,
    partial:Boolean(Number.isInteger(limit)&&limit>0),
    usdtQuotes:items.filter(t=>t.quoteAsset==='USDT').length,
    usdcQuotes:items.filter(t=>t.quoteAsset==='USDC').length,
    completedAt:iso()
  };
  console.log('FUTURES USD-M',JSON.stringify(coverage),'LONG',
    rows.filter(r=>r.status==='signal'&&r.side==='buy').length,
    'SHORT',rows.filter(r=>r.status==='signal'&&r.side==='sell').length);
  return {data:rows,coverage};
}
function appendFuturesSignals(history,rows) {
  const result=Array.isArray(history)?history.slice():[];
  const seen=new Set(result.map(h=>h.signalKey));
  for(const r of rows){
    if(r.status!=='signal'||seen.has(r.signalKey))continue;
    const {id,kind,symbol,name,quoteAsset,side,direction,entry,stop,tp1,tp2,score,
      signalKey,url,setupVersion,fundingRatePct,spreadPct,riskPct,marketProvider}=r;
    result.unshift({id,kind,symbol,name,quoteAsset,side,direction,entry,stop,tp1,tp2,score,
      signalKey,url,setupVersion,fundingRatePct,spreadPct,riskPct,marketProvider:marketProvider||'Binance',
      detectedAt:iso(),outcome:'open'});
    seen.add(signalKey);
  }
  return result.slice(0,MAX_HISTORY);
}
async function auditFutures(hist) {
  const open=hist.filter(h=>h.marketProvider!=='Gate.io'&&(h.outcome==='open'||h.outcome==='tp1'&&!h.closedAt));
  let assessed=0,failures=0;
  for(let i=0;i<Math.min(open.length,35);i+=6){
    const pending=open.slice(i,i+6);
    const checked=await Promise.allSettled(pending.map(async h=>{
      const detected=Date.parse(h.detectedAt);
      if(!Number.isFinite(detected))return;
      const first=(Math.floor(detected/60000)+1)*60000;
      const expiry=first+4*3600000;
      const end=Math.min(expiry,Date.now()-60000);
      const from=Math.max(first,Number(h.checkedUntil||0)+1);
      if(from>end) {
        if(end===expiry&&!h.closedAt){h.outcome=h.tp1At?'tp1':'expired';h.closedAt=new Date(expiry).toISOString();}
        return;
      }
      const candles=await getJson(API+'/klines?symbol='+encodeURIComponent(h.name)+
        '&interval=1m&startTime='+from+'&endTime='+end+'&limit=1000',16000);
      if(!Array.isArray(candles))throw Error('Sin velas de auditoría');
      for(const v of candles){
        const ot=num(v[0]),ct=num(v[6]),high=num(v[2]),low=num(v[3]);
        if(ot<from||ct>=Date.now()||high<=0||low<=0)continue;
        h.checkedUntil=ct;
        const short=h.side==='sell';
        const sl=short?high>=h.stop:low<=h.stop;
        const p1=short?low<=h.tp1:high>=h.tp1;
        const p2=short?low<=h.tp2:high>=h.tp2;
        if(!h.tp1At){
          if(sl&&p1){h.outcome='ambiguous';h.closedAt=new Date(ct).toISOString();break;}
          if(sl){h.outcome='sl';h.closedAt=new Date(ct).toISOString();break;}
          if(p2){h.tp1At=new Date(ct).toISOString();h.tp2At=h.tp1At;h.outcome='tp2';h.closedAt=h.tp2At;break;}
          if(p1){h.tp1At=new Date(ct).toISOString();h.outcome='tp1';}
        }else{
          if(p2&&sl){h.outcome='tp1';h.closedAt=new Date(ct).toISOString();break;}
          if(p2){h.tp2At=new Date(ct).toISOString();h.outcome='tp2';h.closedAt=h.tp2At;break;}
          if(sl){h.outcome='tp1';h.closedAt=new Date(ct).toISOString();break;}
        }
      }
      if(end===expiry&&!h.closedAt){h.outcome=h.tp1At?'tp1':'expired';h.closedAt=new Date(expiry).toISOString();}
      assessed++;
    }));
    failures+=checked.filter(x=>x.status==='rejected').length;
    if(i+6<Math.min(open.length,35))await wait(220);
  }
  console.log('Futures outcomes',JSON.stringify({open:open.length,assessed,failures}));
  return hist;
}
function futuresStats(hist) {
  const outcomes={};
  for(const direction of ['LONG','SHORT']){
    const rows=hist.filter(x=>x.direction===direction);
    outcomes[direction]={all:rows.length,pending:rows.filter(x=>x.outcome==='open'||x.outcome==='tp1'&&!x.closedAt).length,
      tp1:rows.filter(x=>x.outcome==='tp1'&&x.closedAt).length,
      tp2:rows.filter(x=>x.outcome==='tp2').length,sl:rows.filter(x=>x.outcome==='sl').length,
      ambiguous:rows.filter(x=>x.outcome==='ambiguous').length,expired:rows.filter(x=>x.outcome==='expired').length};
  }
  return outcomes;
}
if(typeof module!=='undefined'&&module.exports)module.exports={scanFutures,analyzeFuturesPair,appendFuturesSignals,auditFutures,futuresStats};
if(typeof window!=='undefined')window.CriptoFutures={scanFutures};
