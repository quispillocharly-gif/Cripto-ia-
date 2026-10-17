'use strict';
// Gate.io USDT perpetuals: independent fallback for public derivatives analysis.
// Never submits orders and never mislabels Gate data as Binance data.
const API='https://api.gateio.ws/api/v4/futures/usdt';
const val=x=>Number(x)||0;
const cap=(x,a,b)=>Math.max(a,Math.min(b,x));
const delay=ms=>new Promise(ok=>setTimeout(ok,ms));
const at=()=>new Date().toISOString();

async function publicData(path,timeout=17000){
  let last;
  for(let i=0;i<2;i++){
    try{
      const r=await fetch(API+path,{headers:{accept:'application/json'},signal:AbortSignal.timeout(timeout)});
      if(!r.ok){
        if((r.status===429||r.status>=500)&&i===0){await delay(1200);continue;}
        throw Error('Gate Futures HTTP '+r.status);
      }
      const j=await r.json();
      if(j?.label)throw Error('Gate API '+String(j.label));
      return j;
    }catch(e){last=e;if(i===0&&!/HTTP 4/.test(String(e.message)))await delay(500);}
  }
  throw last||Error('Gate Futures sin datos');
}
function ema(a,n){
 const k=2/(n+1);let s=a[0];return a.map(v=>s=v*k+s*(1-k));
}
function rsi(a,n=14){
 if(a.length<n+2)return 50;
 let u=0,d=0;
 for(let i=1;i<=n;i++){const dif=a[i]-a[i-1];u+=Math.max(0,dif);d+=Math.max(0,-dif);}
 u/=n;d/=n;
 for(let i=n+1;i<a.length;i++){const dif=a[i]-a[i-1];u=(u*(n-1)+Math.max(0,dif))/n;d=(d*(n-1)+Math.max(0,-dif))/n;}
 return d===0?(u?100:50):100-100/(1+u/d);
}
function atr(b,n=14){
 if(b.length<n+2)return 0;
 let a=0;
 for(let i=1;i<=n;i++)a+=Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c));
 a/=n;
 for(let i=n+1;i<b.length;i++){
  const v=Math.max(b[i].h-b[i].l,Math.abs(b[i].h-b[i-1].c),Math.abs(b[i].l-b[i-1].c));
  a=(a*(n-1)+v)/n;
 }
 return a;
}
function normalize(raw,intervalMs,now=Date.now()){
 if(!Array.isArray(raw))return [];
 return raw.map(x=>({ts:val(x.t)*1000,o:val(x.o),h:val(x.h),l:val(x.l),c:val(x.c),q:val(x.sum),v:val(x.v)}))
  .filter(b=>b.ts>0&&b.o>0&&b.h>=b.l&&b.c>0&&b.ts+intervalMs<=now)
  .sort((a,b)=>a.ts-b.ts);
}
function fallback(t,reason){
 const name=String(t.contract||t.name||'');
 return {id:'futures:gate:'+name,kind:'futures',marketProvider:'Gate.io',name,
  symbol:name.replace(/_USDT$/,''),quoteAsset:'USDT',chain:'Gate.io USDT PERPETUAL',
  side:'none',direction:'—',status:'catalog',score:null,entry:null,stop:null,tp1:null,tp2:null,
  price:val(t.last),volume:val(t.volume_24h_quote),change1:val(t.change_percentage),
  detailLevel:'24h',updatedAt:at(),origin:'Gate.io USDT perpetual market',
  why:['Contrato disponible; no hay confirmación técnica'],risks:[reason],
  url:'https://www.gate.com/en-us/futures/USDT/'+encodeURIComponent(name)};
}
function evaluateGate(raw,ticker,clock=Date.now()){
 const bars=normalize(raw,300000,clock);
 if(bars.length<75)return null;
 const last=bars.at(-1);
 if(clock-(last.ts+300000)>17*60000)return null;
 const older=bars.slice(0,-1),cs=bars.map(b=>b.c);
 const e20=ema(cs,20),e50=ema(cs,50),R=rsi(cs),A=atr(bars);
 if(A<=0)return null;
 const q=older.slice(-20).reduce((s,b)=>s+b.q,0)/20;
 const ratio=q>0?last.q/q:0;
 const hi=Math.max(...older.slice(-20).map(b=>b.h));
 const lo=Math.min(...older.slice(-20).map(b=>b.l));
 const isBreakUp=last.c>hi,isBreakDown=last.c<lo;
 const momentum=100*(last.c/bars.at(-4).c-1);
 const slope=100*(e20.at(-1)/e20.at(-5)-1);
 const range=Math.max(1e-12,last.h-last.l),rank=(last.c-last.l)/range;
 const uw=(last.h-Math.max(last.c,last.o))/range;
 const lw=(Math.min(last.c,last.o)-last.l)/range;
 const ask=val(ticker.lowest_ask),bid=val(ticker.highest_bid);
 const spread=ask>bid&&bid>0?100*(ask-bid)/((ask+bid)/2):null;
 const funding=Number.isFinite(Number(ticker.funding_rate))?Number(ticker.funding_rate)*100:null;
 const quote24=val(ticker.volume_24h_quote);
 const lastPrice=val(ticker.last);
 const mismatch=lastPrice>0?Math.abs(lastPrice-last.c)/last.c:1;
 const blocked=quote24<1000000||spread===null||spread>.30||
   funding===null||Math.abs(funding)>.14||mismatch>.035;
 const reasons=[],warnings=[];
 if(quote24<1000000)warnings.push('Volumen 24 h insuficiente');
 if(spread===null)warnings.push('Spread no verificable');
 else if(spread>.30)warnings.push('Spread alto');
 if(mismatch>.035)warnings.push('Último precio y vela no coinciden');
 if(funding===null)warnings.push('Funding no recibido');
 else if(Math.abs(funding)>.14)warnings.push('Funding extremo');
 const longReasons=[],shortReasons=[],longRisks=[],shortRisks=[];
 let long=12,short=12;
 if(e20.at(-1)>e50.at(-1)&&last.c>e20.at(-1)){long+=23;longReasons.push('EMA20 > EMA50');}
 else long-=12;
 if(e20.at(-1)<e50.at(-1)&&last.c<e20.at(-1)){short+=23;shortReasons.push('EMA20 < EMA50');}
 else short-=12;
 if(slope>.045)long+=11;else if(slope<-.01)long-=8;
 if(slope<-.045)short+=11;else if(slope>.01)short-=8;
 if(R>=49&&R<=67){long+=15;longReasons.push('RSI sin sobrecompra');}
 else if(R>72){long-=20;longRisks.push('Sobrecompra');}
 if(R<=51&&R>=31){short+=15;shortReasons.push('RSI sin sobreventa');}
 else if(R<27){short-=20;shortRisks.push('Sobreventa');}
 if(ratio>=1.55){long+=20;short+=20;longReasons.push('Volumen inusual');shortReasons.push('Volumen inusual');}
 else if(ratio>=1.16){long+=10;short+=10;}
 else{long-=7;short-=7;}
 if(isBreakUp){long+=20;longReasons.push('Rompe resistencia 20 velas');}
 if(isBreakDown){short+=20;shortReasons.push('Rompe soporte 20 velas');}
 if(momentum>.15&&momentum<2.4){long+=9;longReasons.push('Impulso temprano');}
 else if(momentum>3.1){long-=22;longRisks.push('Subida extendida');}
 if(momentum<-.15&&momentum>-2.4){short+=9;shortReasons.push('Caída temprana');}
 else if(momentum< -3.1){short-=22;shortRisks.push('Caída extendida');}
 if(rank>=.72&&uw<=.27){long+=10;longReasons.push('Cierre sólido');}
 else if(rank<.47){long-=14;longRisks.push('Rechazo alcista');}
 if(rank<=.28&&lw<=.27){short+=10;shortReasons.push('Cierre bajo');}
 else if(rank>.53){short-=14;shortRisks.push('Rebote alcista');}
 if(funding!==null&&funding>.055){long-=8;longRisks.push('Funding positivo elevado');}
 if(funding!==null&&funding<-.055){short-=8;shortRisks.push('Funding negativo elevado');}
 long=cap(Math.round(long),0,100);short=cap(Math.round(short),0,100);
 const longOK=!blocked&&long>=78&&isBreakUp&&ratio>=1.15&&
   rank>=.68&&uw<=.30&&R<69&&momentum>=.12&&momentum<2.8;
 const shortOK=!blocked&&short>=78&&isBreakDown&&ratio>=1.15&&
   rank<=.32&&lw<=.30&&R>29&&momentum<=-.12&&momentum> -2.8;
 const side=longOK?'buy':shortOK?'sell':long>=short?'buy':'sell';
 const confirmed=side==='buy'?longOK:shortOK;
 const score=side==='buy'?long:short;
 const entry=last.c,dist=cap(Math.max(1.5*A,entry*.008),entry*.006,entry*.045);
 const name=String(ticker.contract),down=side==='sell';
 return {
  id:'futures:gate:'+name,kind:'futures',marketProvider:'Gate.io',
  symbol:name.replace(/_USDT$/,''),name,quoteAsset:'USDT',
  chain:'Gate.io USDT PERPETUAL',side,direction:down?'SHORT':'LONG',
  score,status:confirmed?'signal':!blocked&&score>=53?'watch':'reject',
  why:side==='buy'?longReasons:shortReasons,
  risks:[...warnings,...(down?shortRisks:longRisks),'Presión taker no disponible en estas velas'],
  entry,stop:down?entry+dist:entry-dist,
  tp1:down?Math.max(0,entry-1.5*dist):entry+1.5*dist,
  tp2:down?Math.max(0,entry-2.3*dist):entry+2.3*dist,
  price:lastPrice||entry,volume:quote24,change5:+momentum.toFixed(2),
  change1:val(ticker.change_percentage),volRatio:+ratio.toFixed(2),rsi:+R.toFixed(1),
  spreadPct:spread===null?null:+spread.toFixed(3),
  fundingRatePct:funding===null?null:+funding.toFixed(4),
  riskPct:+(100*dist/entry).toFixed(2),
  setupVersion:'GATE_PERP_FLOW_V1',origin:'Gate.io Futures USDT perpetuos',
  updatedAt:at(),candleClosedAt:new Date(last.ts+300000).toISOString(),detailLevel:'ohlc',
  signalKey:'futures:gate:'+name+':'+side+':'+last.ts,
  url:'https://www.gate.com/en-us/futures/USDT/'+encodeURIComponent(name)
 };
}
async function scanGateFutures({limit=null}={}){
 const [contracts,tickers]=await Promise.all([publicData('/contracts',22000),publicData('/tickers',22000)]);
 if(!Array.isArray(contracts)||!Array.isArray(tickers)||!contracts.length||!tickers.length)
  throw Error('Gate Futures: listado de contratos incompleto');
 const available=new Set(contracts.filter(x=>x.name&&x.in_delisting!==true&&x.type!=='inverse')
  .map(x=>x.name));
 const all=tickers.filter(x=>available.has(x.contract)&&
  /^[A-Za-z0-9]+_USDT$/.test(String(x.contract))&&val(x.last)>0)
  .sort((a,b)=>val(b.volume_24h_quote)-val(a.volume_24h_quote));
 if(!all.length)throw Error('Gate Futures: sin contratos de USDT válidos');
 const selected=Number.isInteger(limit)&&limit>0?all.slice(0,Math.min(limit,100)):all;
 const rows=[];let detailed=0,stale=0,apiErrors=0;
 for(let i=0;i<selected.length;i+=9){
  const group=selected.slice(i,i+9);
  const requests=await Promise.allSettled(group.map(t=>publicData('/candlesticks?contract='+encodeURIComponent(t.contract)+'&interval=5m&limit=110',19000)));
  group.forEach((t,j)=>{
    if(requests[j].status!=='fulfilled'){rows.push(fallback(t,'Velas no disponibles en la API de Gate'));apiErrors++;return;}
    const result=evaluateGate(requests[j].value,t);
    if(result){rows.push(result);detailed++;}
    else{rows.push(fallback(t,'Velas insuficientes o demasiado antiguas'));stale++;}
  });
  if(i+9<selected.length)await delay(190);
 }
 const priority={signal:0,watch:1,reject:2,catalog:3};
 rows.sort((a,b)=>(priority[a.status]??4)-(priority[b.status]??4)||(b.score||0)-(a.score||0));
 const coverage={catalogueContracts:contracts.length,catalogueAssets:all.length,
  selectedForDetail:selected.length,detailed,stale,apiErrors,partial:selected.length<all.length,completedAt:at()};
 console.log('GATE FUTURES: contratos',coverage.catalogueContracts,'evaluados',detailed,'errores',apiErrors,
  'LONG',rows.filter(x=>x.status==='signal'&&x.side==='buy').length,
  'SHORT',rows.filter(x=>x.status==='signal'&&x.side==='sell').length);
 return {data:rows,coverage,provider:'Gate.io'};
}
async function auditGateFutures(history){
 const pending=history.filter(h=>h.marketProvider==='Gate.io'&&
  (h.outcome==='open'||(h.outcome==='tp1'&&!h.closedAt)));
 let assessed=0,errors=0;
 for(let i=0;i<Math.min(pending.length,35);i+=5){
  const batch=pending.slice(i,i+5);
  const settled=await Promise.allSettled(batch.map(async h=>{
   const signalTime=Date.parse(h.detectedAt);
   if(!Number.isFinite(signalTime))return;
   const start=(Math.floor(signalTime/60000)+1)*60000;
   const expiry=start+4*3600000;
   const end=Math.min(expiry,Date.now()-60000);
   const from=Math.max(start,val(h.checkedUntil)+1);
   if(from>end){
    if(end===expiry&&!h.closedAt){h.outcome=h.tp1At?'tp1':'expired';h.closedAt=new Date(expiry).toISOString();}
    return;
   }
   const raw=await publicData('/candlesticks?contract='+encodeURIComponent(h.name)+
    '&interval=1m&from='+Math.floor(from/1000)+'&to='+Math.floor(end/1000),16000);
   const bars=normalize(raw,60000,Date.now()).filter(b=>b.ts>=from-60000&&b.ts+60000>from);
   for(const b of bars){
    const t=b.ts+60000;
    if(t>end+60000)continue;
    h.checkedUntil=t;
    const short=h.side==='sell';
    const sl=short?b.h>=h.stop:b.l<=h.stop;
    const tp1=short?b.l<=h.tp1:b.h>=h.tp1;
    const tp2=short?b.l<=h.tp2:b.h>=h.tp2;
    if(!h.tp1At){
     if(sl&&tp1){h.outcome='ambiguous';h.closedAt=new Date(t).toISOString();break;}
     if(sl){h.outcome='sl';h.closedAt=new Date(t).toISOString();break;}
     if(tp2){h.tp1At=new Date(t).toISOString();h.tp2At=h.tp1At;h.outcome='tp2';h.closedAt=h.tp2At;break;}
     if(tp1){h.tp1At=new Date(t).toISOString();h.outcome='tp1';}
    }else{
     if(tp2&&sl){h.outcome='tp1';h.closedAt=new Date(t).toISOString();break;}
     if(tp2){h.tp2At=new Date(t).toISOString();h.outcome='tp2';h.closedAt=h.tp2At;break;}
     if(sl){h.outcome='tp1';h.closedAt=new Date(t).toISOString();break;}
    }
   }
   if(end===expiry&&!h.closedAt){h.outcome=h.tp1At?'tp1':'expired';h.closedAt=new Date(expiry).toISOString();}
   assessed++;
  }));
  errors+=settled.filter(x=>x.status==='rejected').length;
  if(i+5<Math.min(pending.length,35))await delay(200);
 }
 console.log('Gate audit Futures',JSON.stringify({pending:pending.length,assessed,errors}));
 return history;
}
if(typeof module!=='undefined'&&module.exports)module.exports={scanGateFutures,evaluateGate,auditGateFutures};
if(typeof window!=='undefined')window.CriptoGateFutures={scanGateFutures};
