'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {scanFutures,appendFuturesSignals,auditFutures,futuresStats} = require('./futures');
const {scanGateFutures,auditGateFutures} = require('./gate-futures');
const PORT = Number(process.env.PORT || 3000);
const STORE = process.env.DATA_PATH || '/data/cripto-ia.json';
const PERIOD = 120000;
const $ = (n) => Number(n) || 0;
const clamp = (x,a,b) => Math.min(b,Math.max(a,x));
const pause = ms => new Promise(r => setTimeout(r,ms));
const now = () => new Date().toISOString();
const origins = {spot:'Binance Spot · inventario completo y velas por activo',futures:'Binance USDⓈ-M Futures · perpetuos USDT/USDC',dex:'DEX Screener + GeckoTerminal · nuevos pools y tendencias (cobertura parcial)'};
let state = {
  version:'3.0.0',startedAt:now(),running:false,scans:0,scanStarted:null,scanFinished:null,
  spot:{updatedAt:null,source:origins.spot,error:'Esperando primer escaneo',data:[]},
  futures:{updatedAt:null,source:origins.futures,error:'Esperando primer escaneo',data:[],coverage:null},
  futuresHistory:[],futuresPerformance:{},
  dex:{updatedAt:null,source:origins.dex,error:'Esperando primer escaneo',data:[]},
  history:[],seen:{},events:[]
};
try {
  const saved=JSON.parse(fs.readFileSync(STORE,'utf8'));
  if(saved && typeof saved==='object'){
    for(const kind of ['spot','dex','futures']) if(saved[kind] && Array.isArray(saved[kind].data)) state[kind]=saved[kind];
    if(Array.isArray(saved.history)) state.history=saved.history.slice(0,300);
    if(Array.isArray(saved.futuresHistory))state.futuresHistory=saved.futuresHistory.slice(0,250);
    if(saved.futuresPerformance)state.futuresPerformance=saved.futuresPerformance;
    state.scans=Number(saved.scans)||0;
    state.scanFinished=saved.scanFinished||null;
    if(saved.seen && typeof saved.seen==='object')state.seen=saved.seen;
    if(Array.isArray(saved.events))state.events=saved.events.slice(0,100);
    if(saved.intelligence&&typeof saved.intelligence==='object')state.intelligence=saved.intelligence;
  }
} catch(e) {if(e.code!=='ENOENT') console.warn('Historial no disponible:',e.message);}
function persist(){
  try {fs.mkdirSync(path.dirname(STORE),{recursive:true});fs.writeFileSync(STORE+'.tmp',JSON.stringify({spot:state.spot,dex:state.dex,futures:state.futures,futuresHistory:state.futuresHistory,futuresPerformance:state.futuresPerformance,history:state.history,seen:state.seen,events:state.events,intelligence:state.intelligence,scans:state.scans,scanFinished:state.scanFinished,running:false}));fs.renameSync(STORE+'.tmp',STORE);}
  catch(e){console.warn('No se guardó el estado:',e.message);}
}
async function json(url,timeout=15000){
  for(let n=0;n<3;n++){
    try{
      const r=await fetch(url,{headers:{accept:'application/json','user-agent':'CriptoIARadar/2.3'},signal:AbortSignal.timeout(timeout)});
      if(!r.ok){
        if((r.status===429||r.status===418)&&n<2){
          const retry=Number(r.headers.get('retry-after'));
          await pause(retry>0?Math.min(retry*1000,60000):12000*(n+1));continue;
        }
        throw Error('API HTTP '+r.status);
      }
      return r.json();
    }catch(e){
      if(n===2||/HTTP 4\d\d/.test(String(e.message)))throw e;
      await pause(700*(n+1));
    }
  }
  throw Error('Consulta API sin respuesta');
}
function evaluateDex(p){
  const liq=$(p.liquidity && p.liquidity.usd),price=$(p.priceUsd),vol=p.volume||{},tx=p.txns||{},pc=p.priceChange||{};
  const buys=$(tx.m5 && tx.m5.buys),sells=$(tx.m5 && tx.m5.sells),count=buys+sells;
  const vol5=$(vol.m5),vol1=$(vol.h1),accel=vol1>0?vol5*12/vol1:0,ratio=(buys+1)/(sells+1);
  const m5=$(pc.m5),h1=$(pc.h1),h6=$(pc.h6),age=(Date.now()-$(p.pairCreatedAt))/3600000;
  let score=18,why=[],risks=[],blocked=false;
  if(liq>=25000){score+=16;why.push('Liquidez suficiente');}else{score-=25;blocked=true;risks.push('Liquidez muy baja');}
  if(vol5>=2500 && accel>=1.5){score+=22;why.push('Volumen 5m acelerando x'+accel.toFixed(1));}
  else if(vol5>900 && accel>=1){score+=9;why.push('Volumen estable');}else{score-=8;risks.push('Volumen sin aceleración');}
  if(count>=14 && ratio>=1.3){score+=18;why.push('Presión compradora x'+ratio.toFixed(1));}
  else if(count>=9 && ratio>=1){score+=7;}else{score-=11;risks.push('Ventas dominantes o poca actividad');}
  if(m5>=0.25 && m5<=4.5){score+=18;why.push('Impulso temprano 5m');}
  else if(m5>7){score-=24;risks.push('Movimiento 5m ya extendido');}
  else if(m5<-.5){score-=14;risks.push('Caída en 5m');}
  if(h1>=0.6 && h1<=18){score+=12;why.push('Tendencia de 1h todavía moderada');}
  else if(h1>30){score-=18;risks.push('Subida 1h ya avanzada');}
  else if(h1<0){score-=8;}
  if(h6>95){score-=16;risks.push('Acumulación de subida 6h elevada');}
  if(!$(p.pairCreatedAt)){blocked=true;risks.push('Edad de pool desconocida');}
  else if(age<.5){blocked=true;score-=25;risks.push('Pool menor de 30 min');}
  else if(age<3){score-=7;risks.push('Pool nuevo: alto riesgo');}
  if(!price || !liq || !count){blocked=true;risks.push('Cotización/actividad incompleta');}
  // Descubrimiento por perfiles y boosts es sesgado: nunca interpretar score como probabilidad.
  score=clamp(Math.round(score-6),0,100);
  const longSignal=!blocked&&score>=75&&accel>=1.25&&ratio>=1.2&&m5>=.25&&m5<=4.5&&h1<23&&age>=.5;
  const sellReasons=[],sellRisks=[];
  let sellScore=18;
  if(liq>=25000){sellScore+=16;sellReasons.push('Liquidez para salir');}
  else{sellScore-=25;sellRisks.push('Sin liquidez de salida');}
  if(vol5>=2500&&accel>=1.5){sellScore+=22;sellReasons.push('Volumen vendedor acelerando');}
  else if(vol5>900&&accel>=1)sellScore+=9;
  else sellScore-=8;
  if(count>=14&&ratio<=.72){sellScore+=18;sellReasons.push('Ventas dominantes '+Math.round(100/(ratio+1))+'%');}
  else if(count>=9&&ratio<1)sellScore+=7;
  else{sellScore-=11;sellRisks.push('No dominan las ventas');}
  if(m5<=-.4&&m5>=-5.5){sellScore+=16;sellReasons.push('Caída temprana de 5 min');}
  else if(m5< -9){sellScore-=21;sellRisks.push('Caída ya extendida');}
  else if(m5>0)sellScore-=14;
  if(h1<=-.9&&h1>=-22){sellScore+=12;sellReasons.push('Tendencia bajista 1 h');}
  else if(h1<-40)sellScore-=17;
  else if(h1>0)sellScore-=8;
  if(h6<-95)sellScore-=12;
  sellScore=clamp(Math.round(sellScore-6),0,100);
  const sellSignal=!blocked&&sellScore>=75&&accel>=1.25&&ratio<=.72&&count>=14&&m5<=-.4&&m5>=-5.5&&h1<-.9&&age>=.5;
  const down=sellSignal||(!longSignal&&sellScore>score);
  const side=down?'sell':'buy';
  const scoreFinal=down?sellScore:score;
  const status=longSignal||sellSignal?'signal':(!blocked&&scoreFinal>=52?'watch':'reject');
  const slpct=clamp(Math.max(.045,Math.abs(m5)/100*1.5),.045,.14);
  const risk=price*slpct;
  const addr=(p.baseToken&&p.baseToken.address)||p.pairAddress||'';
  const chain=p.chainId||'desconocida',id='dex:'+chain+':'+addr;
  return {id,kind:'dex',chain,name:(p.baseToken&&p.baseToken.name)||'Token',symbol:(p.baseToken&&p.baseToken.symbol)||'?',price,
    score:scoreFinal,status,side,why:down?sellReasons:why,risks:down?sellRisks:risks,entry:price,
    stop:down?price+risk:price-risk,tp1:down?Math.max(0,price-1.6*risk):price+1.6*risk,
    tp2:down?Math.max(0,price-2.4*risk):price+2.4*risk,
    volume:vol5,liquidity:liq,change5:m5,change1:h1,accel:+accel.toFixed(2),buyRatio:+ratio.toFixed(2),
    isNew:age>=0&&age<24,newHours:Math.round(age*10)/10,origin:p.origin||'DEX Screener',
    url:p.viewUrl||('https://dexscreener.com/'+encodeURIComponent(chain)+'/'+encodeURIComponent(p.pairAddress||addr)),
    signalKey:id+':'+Math.floor(Date.now()/900000),updatedAt:now()};
}
const DEX_NETWORKS=['solana','base','ethereum','bsc','arbitrum','polygon','avalanche','optimism','sui','ton'];
const GEO_TO_CHAIN={eth:'ethereum',polygon_pos:'polygon',avax:'avalanche'};
function geckoToPair(pool,origin){
  const a=pool?.attributes||{};
  const network=pool.relationships?.network?.data?.id||String(pool.id||'').split('_')[0];
  const chain=GEO_TO_CHAIN[network]||network;
  const tokenRef=pool.relationships?.base_token?.data?.id||'';
  const address=String(tokenRef).replace(/^[^_]*_/,'');
  if(!tokenRef||!address||!a.address||!$(a.base_token_price_usd))return null;
  const name=String(a.name||'Token / Pair').split(' / ')[0]||'Token';
  return {chainId:chain,pairAddress:a.address,baseToken:{address,name,symbol:name},priceUsd:a.base_token_price_usd,
    liquidity:{usd:a.reserve_in_usd},volume:{m5:a.volume_usd?.m5,h1:a.volume_usd?.h1},
    txns:{m5:a.transactions?.m5},priceChange:{m5:a.price_change_percentage?.m5,
      h1:a.price_change_percentage?.h1,h6:a.price_change_percentage?.h6},
    pairCreatedAt:Date.parse(a.pool_created_at||'')||0,origin,
    viewUrl:'https://www.geckoterminal.com/'+encodeURIComponent(network)+'/pools/'+encodeURIComponent(a.address)};
}
async function scanGecko(){
  const base='https://api.geckoterminal.com/api/v2';
  const rotating=['solana','base','eth','bsc','arbitrum','polygon_pos','avax','optimism','sui','ton'];
  const i=(state.scans*4)%rotating.length;
  const selected=[...new Set(['solana','base',rotating[i],rotating[(i+1)%rotating.length]])];
  const paths=['/networks/new_pools','/networks/trending_pools',...selected.map(x=>'/networks/'+x+'/new_pools')];
  const rows=[];let succeeded=0;
  // GeckoTerminal public API: ~10 requests per minute. 6 serial queries.
  for(let n=0;n<paths.length;n++){
    try{
      const data=await json(base+paths[n]+'?include=base_token',15000);
      if(Array.isArray(data?.data)){
        succeeded++;
        for(const pool of data.data){
          const p=geckoToPair(pool,paths[n].includes('new_pools')?'GeckoTerminal · nuevos pools':'GeckoTerminal · tendencias');
          if(p)rows.push(p);
        }
      }
    }catch(e){console.warn('Gecko',paths[n],String(e.message||e));}
    if(n<paths.length-1)await pause(1250);
  }
  console.log('GeckoTerminal consultas',succeeded,'/',paths.length,'pares',rows.length);
  return rows;
}
async function scanDex(){
  const urls=[
    'https://api.dexscreener.com/token-profiles/latest/v1',
    'https://api.dexscreener.com/token-boosts/latest/v1',
    'https://api.dexscreener.com/token-boosts/top/v1',
    'https://api.dexscreener.com/community-takeovers/latest/v1',
    'https://api.dexscreener.com/token-profiles/recent-updates/v1'
  ];
  const res=await Promise.allSettled(urls.map(u=>json(u)));
  const refs=res.filter(x=>x.status==='fulfilled'&&Array.isArray(x.value)).flatMap(x=>x.value);
  const groups=new Map();
  function add(chain,address){
    if(!DEX_NETWORKS.includes(chain)||!address)return;
    const a=groups.get(chain)||new Set();a.add(address);groups.set(chain,a);
  }
  for(const t of refs)add(t.chainId,t.tokenAddress);
  // Recheck previously discarded and watched tokens even when absent from latest listings.
  const seenRows=Object.entries(state.seen||{}).filter(([id,v])=>id.startsWith('dex:')&&
    Date.now()-Date.parse(v.lastSeenAt||'1970-01-01')<72*3600000).sort((a,b)=>{
      const priority=v=>(v?.lastStatus==='reject'?0:v?.lastStatus==='watch'?1:2);
      return priority(a[1])-priority(b[1])||Date.parse(a[1].lastCheckedAt||'1970-01-01')-Date.parse(b[1].lastCheckedAt||'1970-01-01');
    });
  for(const [id] of seenRows.slice(0,65)){
    const m=id.match(/^dex:([^:]+):(.+)$/);
    if(m)add(m[1],m[2]);
  }
  const requests=[];
  for(const [chain,set] of groups){
    const xs=[...set].slice(0,180);
    for(let n=0;n<xs.length;n+=30)requests.push('https://api.dexscreener.com/tokens/v1/'+encodeURIComponent(chain)+'/'+xs.slice(n,n+30).map(encodeURIComponent).join(','));
  }
  let fetched=[];
  for(let i=0;i<requests.length;i+=8){
    const rs=await Promise.allSettled(requests.slice(i,i+8).map(x=>json(x)));
    fetched.push(...rs.filter(x=>x.status==='fulfilled'&&Array.isArray(x.value)).flatMap(x=>x.value));
    if(i+8<requests.length)await pause(500);
  }
  const gecko=await scanGecko();
  const best=new Map();
  for(const p of [...fetched.map(x=>({...x,origin:'DEX Screener · perfiles/comunidad'})),...gecko]){
    if(!p?.baseToken?.address||!DEX_NETWORKS.includes(p.chainId))continue;
    const key=p.chainId+':'+p.baseToken.address;
    const old=best.get(key);
    if(!old||$(old.liquidity?.usd)<$(p.liquidity?.usd))best.set(key,p);
  }
  if(!best.size)throw Error('No se recibieron datos DEX evaluables');
  const rows=[...best.values()].map(evaluateDex).sort((a,b)=>b.score-a.score);
  // Return every evaluated token, not only the 100 highest scores.
  console.log('DEX descubierto',refs.length,'consultado',requests.length,'Gecko',gecko.length,'únicos',rows.length);
  return rows.slice(0,650);
}
function ema(cs,n){const alpha=2/(n+1);let v=cs[0];return cs.map(x=>v=v+alpha*(x-v));}
function rsi(cs,n=14){
  if(cs.length<=n)return 50;
  let u=0,d=0;for(let i=1;i<=n;i++){const diff=cs[i]-cs[i-1];u+=Math.max(diff,0);d+=Math.max(-diff,0);}
  u/=n;d/=n;for(let i=n+1;i<cs.length;i++){const diff=cs[i]-cs[i-1];u=(u*(n-1)+Math.max(diff,0))/n;d=(d*(n-1)+Math.max(-diff,0))/n;}
  return !d?(u?100:50):100-100/(1+u/d);
}
function atr(bs,n=14){
  if(bs.length<n+1)return 0;
  let a=0;for(let i=1;i<=n;i++)a+=Math.max(bs[i].h-bs[i].l,Math.abs(bs[i].h-bs[i-1].c),Math.abs(bs[i].l-bs[i-1].c));
  a/=n;for(let i=n+1;i<bs.length;i++){const t=Math.max(bs[i].h-bs[i].l,Math.abs(bs[i].h-bs[i-1].c),Math.abs(bs[i].l-bs[i-1].c));a=(a*(n-1)+t)/n;}return a;
}
// Empirical evidence, not a probability guarantee. Each label is based only on
// previously closed historical signals, excluding pending/expired DEX signals.
function evidenceFor(kind,setupVersion){
  const recent=(state.history||[]).filter(h=>h.kind===kind &&
    (h.outcome==='sl'||h.outcome==='tp2'||(h.outcome==='tp1'&&h.closedAt)) &&
    (!setupVersion||h.setupVersion===setupVersion));
  const wins=recent.filter(h=>h.outcome==='tp1'||h.outcome==='tp2').length;
  const losses=recent.length-wins;
  const n=recent.length;
  // Beta(2,3) is deliberately conservative when a strategy has few observations.
  const posterior=(wins+2)/(n+5);
  return {sample:n,wins,losses,observedHitRate:n?+(100*wins/n).toFixed(1):null,
    smoothedHitRate:+(100*posterior).toFixed(1),validated:n>=40,
    label:n<40?'Muestra insuficiente':posterior>=.4?'Racha a evaluar':'Rendimiento débil'};
}
function evaluateSpot(raw,t){
  const bs=raw.map(b=>({o:$(b[1]),h:$(b[2]),l:$(b[3]),c:$(b[4]),v:$(b[5]),quoteVolume:$(b[7]),takerBuyQuote:$(b[10]),time:$(b[6])})).filter(b=>b.c>0 && b.h>0 && b.time<=Date.now());
  if(bs.length<75)return null;
  const last=bs[bs.length-1],older=bs.slice(0,-1),cs=bs.map(b=>b.c);
  // Exclude delisted/inactive markets whose most recent closed candle is stale.
  if(Date.now()-last.time>15*60*1000 || last.time>Date.now()+1000)return null;
  const e20=ema(cs,20),e50=ema(cs,50),R=rsi(cs),A=atr(bs);
  const volumeBase=older.slice(-20).reduce((a,b)=>a+b.v,0)/20,vr=volumeBase?last.v/volumeBase:0;
  const peak=Math.max(...older.slice(-20).map(b=>b.h)),breakout=last.c>peak;
  const momentum=100*(last.c/bs[bs.length-4].c-1),slope=100*(e20.at(-1)/e20.at(-5)-1);
  const recent3=bs.slice(-3),recentVol=recent3.reduce((a,b)=>a+b.quoteVolume,0);
  const buyers=recent3.reduce((a,b)=>a+b.takerBuyQuote,0);
  const takerShare=recentVol>0?buyers/recentVol:null;
  const candleRange=Math.max(1e-12,last.h-last.l);
  const closePosition=clamp((last.c-last.l)/candleRange,0,1);
  const upperWick=clamp((last.h-Math.max(last.o,last.c))/candleRange,0,1);
  const ask=$(t.askPrice),bid=$(t.bidPrice);
  const spreadPct=ask>bid&&bid>0?100*(ask-bid)/((ask+bid)/2):null;
  const microPass=takerShare!==null && takerShare>=.515 && closePosition>=.67 &&
    upperWick<=.3 && last.c>last.o;
  const e=evidenceFor('spot','FLOW_V2');
  let score=12,why=[],risks=[];
  if(takerShare!==null){
    if(takerShare>=.56){score+=12;why.push('Compras agresivas '+Math.round(takerShare*100)+'%');}
    else if(takerShare<.48){score-=20;risks.push('Predominan ventas ejecutadas');}
    else if(takerShare>=.515){score+=5;why.push('Presión compradora confirmada');}
  }
  if(closePosition>=.76&&upperWick<=.2){score+=9;why.push('Cierre sólido sin rechazo superior');}
  else if(closePosition<.58||upperWick>.38){score-=17;risks.push('Rechazo o cierre débil de vela');}
  if(spreadPct!==null){if(spreadPct>.35){score-=20;risks.push('Spread elevado '+spreadPct.toFixed(2)+'%');}
    else if(spreadPct>.15){score-=8;risks.push('Spread moderado '+spreadPct.toFixed(2)+'%');}}

  if(e20.at(-1)>e50.at(-1) && last.c>e20.at(-1)){score+=22;why.push('EMA20 > EMA50');}else{score-=9;risks.push('Tendencia no confirmada');}
  if(slope>.05){score+=10;why.push('EMA20 ascendiendo');}else if(slope<0)score-=8;
  if(R>=49 && R<=65){score+=16;why.push('RSI de impulso temprano');}
  else if(R>70){score-=19;risks.push('RSI sobrecalentado');}else if(R<45)score-=10;
  if(vr>=1.6){score+=20;why.push('Volumen x'+vr.toFixed(1));}else if(vr>=1.15){score+=10;}else{score-=6;risks.push('Falta volumen');}
  if(breakout){score+=18;why.push('Ruptura de máximos 20 velas');}
  else if((peak-last.c)/peak<.008){score+=6;why.push('Cerca de resistencia');}else score-=3;
  if(momentum>.12 && momentum<1.9){score+=11;why.push('Impulso temprano 3 velas');}
  else if(momentum>3.1){score-=17;risks.push('Precio avanzado, posible persecución');}
  else if(momentum<-.2)score-=6;
  const priceDeviation=Math.abs($(t.lastPrice)-last.c)/last.c;
  const blocked=!A || $(t.quoteVolume)<300000 || !Number.isFinite(priceDeviation) || priceDeviation>.025 || (spreadPct!==null&&spreadPct>.35);
  if(priceDeviation>.025)risks.push('Precio y vela inconsistentes: descartar');
  if(blocked)risks.push('Mercado ilíquido o volatilidad insuficiente');
  score=clamp(Math.round(score),0,100);
  const trough=Math.min(...older.slice(-20).map(b=>b.l));
  const breakdown=last.c<trough;
  const eSell=evidenceFor('spot','FLOW_BEAR_V1');
  const sellReasons=[],sellRisks=[];
  let bearScore=12;
  if(e20.at(-1)<e50.at(-1)&&last.c<e20.at(-1)){bearScore+=22;sellReasons.push('EMA bajista');}
  else{bearScore-=10;sellRisks.push('Tendencia bajista no confirmada');}
  if(slope<-.05){bearScore+=10;sellReasons.push('EMA20 descendiendo');}
  else if(slope>0)bearScore-=9;
  if(R>=32&&R<=51){bearScore+=16;sellReasons.push('RSI bajista');}
  else if(R<25){bearScore-=18;sellRisks.push('Sobreventa extrema');}
  else if(R>57)bearScore-=12;
  if(vr>=1.6){bearScore+=20;sellReasons.push('Volumen vendedor alto');}
  else if(vr>=1.15)bearScore+=10;
  else bearScore-=6;
  if(breakdown){bearScore+=18;sellReasons.push('Ruptura de soporte 20 velas');}
  else bearScore-=5;
  if(momentum<-.12&&momentum>-1.9){bearScore+=11;sellReasons.push('Caída temprana 3 velas');}
  else if(momentum<-3.1){bearScore-=17;sellRisks.push('Caída extendida');}
  else if(momentum>.2)bearScore-=6;
  if(takerShare!==null){
    if(takerShare<=.44){bearScore+=12;sellReasons.push('Ventas ejecutadas '+Math.round((1-takerShare)*100)+'%');}
    else if(takerShare<.485){bearScore+=5;}
    else if(takerShare>.52){bearScore-=20;sellRisks.push('Compras dominantes');}
  }
  const lowerWick=clamp((Math.min(last.o,last.c)-last.l)/candleRange,0,1);
  if(closePosition<=.24&&lowerWick<=.2){bearScore+=9;sellReasons.push('Cierre bajista sin rebote');}
  else if(closePosition>.42||lowerWick>.36){bearScore-=17;sellRisks.push('Rechazo inferior');}
  if(spreadPct!==null&&spreadPct>.15)bearScore-=spreadPct>.35?20:8;
  bearScore=clamp(Math.round(bearScore),0,100);
  const sellFlow=takerShare!==null&&takerShare<=.485&&closePosition<=.33&&lowerWick<=.3&&last.c<last.o;
  const sellPenalty=eSell.validated&&eSell.smoothedHitRate<36;
  const sellConfirmed=!blocked&&bearScore>=78&&breakdown&&vr>=1.15&&R>=30&&R<=53&&
    momentum<-.12&&momentum>-2.8&&sellFlow&&!sellPenalty;
  const samplePenalty=e.validated&&e.smoothedHitRate<36;
  if(samplePenalty)risks.push('Historial de este modelo aún desfavorable');
  const validCandidate=!blocked && score>=78 && breakout && vr>=1.15 && R<=67 && momentum<2.8 && microPass;
  const buyConfirmed=validCandidate&&!samplePenalty;
  const direction=sellConfirmed?'sell':buyConfirmed?'buy':bearScore>score?'sell':'buy';
  const signal=sellConfirmed||buyConfirmed;
  const shadowCandidate=!signal&&validCandidate&&samplePenalty&&direction==='buy';
  const chosenScore=direction==='sell'?bearScore:score;
  const status=signal?'signal':(!blocked&&chosenScore>=50?'watch':'reject');
  const risk=Math.max(1.5*A,last.c*.009);
  const id='spot:'+t.symbol;
  const down=direction==='sell';
  const reasons=down?sellReasons:why;
  const warnings=down?sellRisks:risks;
  if(down&&sellPenalty)warnings.push('Historial de señales bajistas todavía desfavorable');
  return {id,kind:'spot',chain:'Binance Spot',symbol:t.baseAsset||t.symbol.replace(/USDT$/,''),name:t.symbol,quoteAsset:t.quoteAsset||'USDT',price:$(t.lastPrice)||last.c,
    side:direction,score:chosenScore,status,why:reasons,risks:warnings,entry:last.c,
    stop:down?last.c+risk:last.c-risk,tp1:down?Math.max(0,last.c-1.7*risk):last.c+1.7*risk,
    tp2:down?Math.max(0,last.c-2.5*risk):last.c+2.5*risk,
    volume:$(t.quoteVolume),change5:momentum,change1:$(t.priceChangePercent),volRatio:+vr.toFixed(2),rsi:+R.toFixed(1),origin:'Binance Spot',
    takerBuyPct:takerShare===null?null:+(100*takerShare).toFixed(1),
    closeQuality:+(100*closePosition).toFixed(1),upperWickPct:+(100*upperWick).toFixed(1),
    spreadPct:spreadPct===null?null:+spreadPct.toFixed(3),
    setupVersion:down?'FLOW_BEAR_V1':'FLOW_V2',empirical:down?eSell:e,shadowCandidate,detailLevel:'ohlc',
    url:'https://www.binance.com/en/trade/'+encodeURIComponent(t.baseAsset||t.symbol.replace(/USDT$/,''))+'_'+encodeURIComponent(t.quoteAsset||'USDT'),
    signalKey:id+':'+last.time,updatedAt:now(),candleClosedAt:new Date(last.time).toISOString()};
}
// Inventory every Binance Spot TRADING pair. For each base asset, prefer its
// most liquid stable-USD quote; otherwise use a major alternative quote.
// All unique assets get candles, not a top-N subset. Unavailable data is tagged.
const PREFERRED_QUOTES=['USDT','USDC','FDUSD','USD1','TUSD','USDP','DAI','BTC','ETH','BNB','EUR','TRY','BRL'];
const USD_QUOTES=new Set(['USDT','USDC','FDUSD','USD1','TUSD','USDP','DAI']);
function catalogueRow(t,reason){
  return {id:'spot:'+t.symbol,kind:'spot',chain:'Binance Spot',symbol:t.baseAsset,name:t.symbol,
    quoteAsset:t.quoteAsset,status:'catalog',side:'none',score:null,price:$(t.lastPrice),
    entry:null,stop:null,tp1:null,tp2:null,volume:$(t.quoteVolume),change5:null,change1:$(t.priceChangePercent),
    why:['Par operable detectado en Binance'],risks:[reason],detailLevel:'catalogue',
    updatedAt:now(),origin:'Binance Spot',url:'https://www.binance.com/en/trade/'+encodeURIComponent(t.baseAsset)+'_'+encodeURIComponent(t.quoteAsset)};
}
async function scanSpot(){
  const root='https://data-api.binance.vision/api/v3/';
  const [exchange,tickers]=await Promise.all([
    json(root+'exchangeInfo?permissions=SPOT',25000),
    json(root+'ticker/24hr',25000)
  ]);
  if(!Array.isArray(exchange?.symbols)||!Array.isArray(tickers))
    throw Error('Catálogo Spot de Binance incompleto');
  const marketList=exchange.symbols.filter(s=>s.status==='TRADING'&&s.isSpotTradingAllowed!==false&&s.baseAsset&&s.quoteAsset);
  const tickerBySymbol=new Map(tickers.map(t=>[t.symbol,t]));
  const best=new Map();
  function preference(t){
    const idx=PREFERRED_QUOTES.indexOf(t.quoteAsset);
    return (idx<0?PREFERRED_QUOTES.length:idx)*100000-Math.min(99999,$(t.quoteVolume)/1000);
  }
  for(const s of marketList){
    const t=tickerBySymbol.get(s.symbol);
    if(!t||$(t.lastPrice)<=0)continue;
    const candidate={...t,baseAsset:s.baseAsset,quoteAsset:s.quoteAsset};
    const old=best.get(s.baseAsset);
    if(!old||preference(candidate)<preference(old))best.set(s.baseAsset,candidate);
  }
  const chosen=[...best.values()].sort((a,b)=>a.baseAsset.localeCompare(b.baseAsset));
  const outcome=[];
  let detailed=0,stale=0,errors=0;
  const batchSize=10;
  for(let i=0;i<chosen.length;i+=batchSize){
    const batch=chosen.slice(i,i+batchSize);
    const rs=await Promise.allSettled(batch.map(t=>json(root+'klines?symbol='+encodeURIComponent(t.symbol)+'&interval=5m&limit=110',18000)));
    for(let j=0;j<batch.length;j++){
      const t=batch[j],v=rs[j];
      if(v.status==='fulfilled'&&Array.isArray(v.value)){
        const row=evaluateSpot(v.value,t);
        if(row){outcome.push(row);detailed++;}
        else{outcome.push(catalogueRow(t,'Velas antiguas o insuficientes, sin señal'));stale++;}
      }else{outcome.push(catalogueRow(t,'Fuente de velas no respondió; sin señal'));errors++;}
    }
    if(i+batchSize<chosen.length)await pause(260);
  }
  if(!chosen.length)throw Error('No hay activos Spot operables en la fuente');
  const ranking={signal:0,watch:1,reject:2,catalog:3};
  outcome.sort((a,b)=>(ranking[a.status]??4)-(ranking[b.status]??4)||(Number(b.score)||0)-(Number(a.score)||0));
  const coverage={cataloguePairs:marketList.length,catalogueAssets:chosen.length,detailed,stale,apiErrors:errors,
    usdQuoted:chosen.filter(t=>USD_QUOTES.has(t.quoteAsset)).length,otherQuotes:chosen.filter(t=>!USD_QUOTES.has(t.quoteAsset)).length,
    completedAt:now(),allVisited:true};
  console.log('Binance catálogo sin top-N',JSON.stringify(coverage));
  console.log('Señales Spot: COMPRA',outcome.filter(r=>r.status==='signal'&&r.side==='buy').length,
    'VENTA',outcome.filter(r=>r.status==='signal'&&r.side==='sell').length,
    'evaluaciones bajistas',outcome.filter(r=>r.side==='sell').length);
  return {data:outcome,coverage};
}
function lifecycle(kind,rows){
  const prev=state.seen||{},events=state.events||[];
  const clock=now();
  for(const r of rows){
    const old=prev[r.id];
    if(old){
      const was=old.lastStatus;
      r.firstSeenAt=old.firstSeenAt;
      r.previousStatus=was;
      if(was==='reject'&&r.status!=='reject'){
        r.reconsidered=true;
        events.unshift({id:r.id,symbol:r.symbol,kind,from:was,to:r.status,score:r.score,at:clock});
      }
      if(was!=='reject'&&r.status==='reject'){
        events.unshift({id:r.id,symbol:r.symbol,kind,from:was,to:r.status,score:r.score,at:clock});
      }
    } else {
      r.firstSeenAt=clock;
      r.previousStatus=null;
    }
    prev[r.id]={firstSeenAt:r.firstSeenAt,lastStatus:r.status,lastSeenAt:clock,lastCheckedAt:clock,lastScore:r.score};
  }
  state.events=events.slice(0,120);
  const entries=Object.entries(prev).sort((a,b)=>Date.parse(b[1].lastSeenAt||'1970-01-01')-Date.parse(a[1].lastSeenAt||'1970-01-01'));
  state.seen=Object.fromEntries(entries.filter(([id,v])=>Date.now()-Date.parse(v.lastSeenAt||'1970-01-01')<7*86400000).slice(0,2600));
}
function appendHistory(rows){
  const existing=new Set(state.history.map(x=>x.signalKey));
  for(const r of rows){
    if((r.status==='signal'||r.shadowCandidate) && !existing.has(r.signalKey)){
      const {id,kind,name,symbol,chain,entry,stop,tp1,tp2,score,signalKey,url,setupVersion,takerBuyPct,spreadPct,closeQuality,shadowCandidate,side,quoteAsset}=r;
      state.history.unshift({id,kind,name,symbol,chain,entry,stop,tp1,tp2,score,signalKey,url,
        setupVersion:setupVersion||'LEGACY',takerBuyPct,spreadPct,closeQuality,shadow:!!shadowCandidate,side:side||'buy',quoteAsset:quoteAsset||'USDT',detectedAt:now(),outcome:'open'});
      existing.add(signalKey);
    }
  }
  state.history=state.history.slice(0,300);
}
// Conservative, verifiable outcome audit for Binance Spot only.
// Examine full 1-minute candles strictly AFTER the detection minute; do not look ahead.
async function verifySpotOutcomes(){
  const full=state.history.filter(h=>h.kind==='spot' &&
    (h.outcome===undefined||h.outcome==='open'||h.outcome==='tp1') &&
    h.symbol && h.detectedAt && $(h.stop)>0 && $(h.tp1)>0 && $(h.tp2)>0);
  let updates=0,errors=0;
  for(let i=0;i<Math.min(full.length,36);i+=6){
    const batch=full.slice(i,i+6);
    const results=await Promise.allSettled(batch.map(async h=>{
      const found=Date.parse(h.detectedAt);
      if(!Number.isFinite(found))return;
      const first=(Math.floor(found/60000)+1)*60000;
      const expiry=first+6*60*60000;
      const end=Math.min(expiry,Date.now()-60000);
      const start=Math.max(first,Number(h.checkedUntil||0)+1);
      if(start>end){
        if(end===expiry && (h.outcome==='open'||!h.outcome)){
          h.outcome='expired';h.closedAt=new Date(expiry).toISOString();updates++;
        } else if(end===expiry && h.outcome==='tp1'){
          h.closedAt=new Date(expiry).toISOString();updates++;
        }
        return;
      }
      const symbol=h.name || h.symbol+'USDT';
      const u='https://data-api.binance.vision/api/v3/klines?symbol='+encodeURIComponent(symbol)+
        '&interval=1m&startTime='+start+'&endTime='+end+'&limit=1000';
      const ks=await json(u,16000);
      if(!Array.isArray(ks))throw Error('Sin velas 1m '+symbol);
      for(const v of ks){
        const openTime=$(v[0]),closeTime=$(v[6]),high=$(v[2]),low=$(v[3]);
        if(openTime<start||closeTime>=Date.now()||!high||!low)continue;
        h.checkedUntil=closeTime;
        const down=h.side==='sell';
        const stop=down?high>=h.stop:low<=h.stop;
        const firstTp=down?low<=h.tp1:high>=h.tp1;
        const secondTp=down?low<=h.tp2:high>=h.tp2;
        const at=new Date(closeTime).toISOString();
        if(!h.tp1At){
          if(stop && firstTp){
            h.outcome='ambiguous';h.closedAt=at;h.ambiguousReason='TP y SL dentro de la misma vela de 1 minuto; no se puede conocer cuál ocurrió primero';
            updates++;break;
          }
          if(stop){h.outcome='sl';h.slAt=at;h.closedAt=at;updates++;break;}
          if(secondTp){h.tp1At=at;h.tp2At=at;h.outcome='tp2';h.closedAt=at;updates++;break;}
          if(firstTp){h.tp1At=at;h.outcome='tp1';updates++;}
        }else{
          if(secondTp && stop){
            h.outcome='tp1';h.closedAt=at;h.ambiguousReason='Después de TP1 se tocaron TP2 y SL en una misma vela: TP2 no confirmado';
            updates++;break;
          }
          if(secondTp){h.tp2At=at;h.outcome='tp2';h.closedAt=at;updates++;break;}
          if(stop){h.outcome='tp1';h.slAt=at;h.closedAt=at;updates++;break;}
        }
      }
      if(end===expiry&&!h.closedAt){
        if(!h.tp1At)h.outcome='expired';
        else h.outcome='tp1';
        h.closedAt=new Date(expiry).toISOString();updates++;
      }
    }));
    errors+=results.filter(x=>x.status==='rejected').length;
    if(i+6<Math.min(full.length,36))await pause(230);
  }
  console.log('Auditoría Spot: pendientes',full.length,'actualizaciones',updates,'errores',errors);
}
let busy=false;
async function cycle(){
  if(busy)return;
  busy=true;state.running=true;state.scanStarted=now();console.log('Escaneo iniciado',state.scanStarted);
  const futuresFeed=scanFutures().catch(async error=>{
    console.warn('Binance Futures no disponible; consultando Gate.io como fuente distinta:',String(error.message||error));
    const gate=await scanGateFutures();
    gate.fallbackReason=String(error.message||error);
    return gate;
  });
  const rs=await Promise.allSettled([scanSpot(),scanDex(),futuresFeed]);
  for(let i=0;i<rs.length;i++){
    const kind=['spot','dex','futures'][i],r=rs[i];
    if(r.status==='fulfilled'){
      const rows=Array.isArray(r.value)?r.value:r.value.data;
      if(kind==='futures'){
        state.futuresHistory=appendFuturesSignals(state.futuresHistory,rows);
      }else{
        lifecycle(kind,rows);
        appendHistory(rows);
      }
      state[kind]={data:rows,updatedAt:now(),source:kind==='futures'?(r.value.provider==='Gate.io'?'Gate.io USDT Futures · datos públicos reales':'Binance USDⓈ-M Futures'):origins[kind],
        error:null,coverage:r.value.coverage||null,provider:kind==='futures'?(r.value.provider||'Binance'):null,
        fallbackReason:kind==='futures'?(r.value.fallbackReason||null):null};
      console.log(kind,'analizados',rows.length,'señales',rows.filter(x=>x.status==='signal').length);
    }else {
      state[kind].error=String(r.reason && r.reason.message || r.reason);
      console.error(kind,state[kind].error);
    }
  }
  try{await verifySpotOutcomes();}catch(e){console.warn('Falló auditoría de objetivos Spot:',e.message);}
  try{await auditFutures(state.futuresHistory);}catch(e){console.warn('Falló auditoría Binance Futures:',e.message);}
  try{await auditGateFutures(state.futuresHistory);}catch(e){console.warn('Falló auditoría Gate Futures:',e.message);}
  state.futuresPerformance=futuresStats(state.futuresHistory);
  state.intelligence={currentModel:'FLOW_V2',legacy:evidenceFor('spot',null),current:evidenceFor('spot','FLOW_V2'),bearish:evidenceFor('spot','FLOW_BEAR_V1'),updatedAt:now()};
  state.scans++;state.running=false;state.scanFinished=now();busy=false;persist();
}
function reply(res,code,data){
  res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});
  res.end(JSON.stringify(data));
}
const HTML=path.join(__dirname,'public','index.html');
if (process.env.ONESHOT !== '1') {
http.createServer((req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost');}catch{reply(res,400,{error:'URL inválida'});return;}
  if(req.method!=='GET'){reply(res,405,{error:'Sólo GET'});return;}
  if(u.pathname==='/api/health')return reply(res,200,{online:true,startedAt:state.startedAt,scans:state.scans,running:state.running,scanFinished:state.scanFinished,spotUpdatedAt:state.spot.updatedAt,dexUpdatedAt:state.dex.updatedAt});
  if(u.pathname==='/api/results')return reply(res,200,{serverTime:now(),running:state.running,scans:state.scans,scanFinished:state.scanFinished,spot:state.spot,dex:state.dex,futures:state.futures,futuresHistory:state.futuresHistory,futuresPerformance:state.futuresPerformance});
  if(u.pathname==='/api/history')return reply(res,200,{data:state.history,events:state.events,futures:state.futuresHistory,futuresPerformance:state.futuresPerformance});
  if(u.pathname==='/api/scan')return reply(res,200,{running:state.running,scanFinished:state.scanFinished,note:'El escaneo se realiza automáticamente en servidor cada 2 minutos.'});
  if(u.pathname==='/' || u.pathname==='/index.html'){
    fs.readFile(HTML,(err,html)=>{if(err){res.writeHead(500);res.end('Vista no disponible');return;}
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});res.end(html);
    });return;
  }
  reply(res,404,{error:'No encontrado'});
}).listen(PORT,'0.0.0.0',()=>console.log('CRIPTO IA servidor activo puerto',PORT));
setTimeout(()=>{cycle().catch(e=>{busy=false;state.running=false;console.error('Ciclo',e);});},1000);
setInterval(()=>{cycle().catch(e=>{busy=false;state.running=false;console.error('Ciclo',e);});},PERIOD);
process.on('SIGTERM',()=>{persist();process.exit(0);});
} else {
  cycle().then(()=>{ console.log('Escaneo único completado'); process.exit(0); }).catch(e=>{console.error('Error de escaneo',e);process.exit(1);});
}
