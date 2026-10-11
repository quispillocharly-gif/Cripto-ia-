'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const PORT = Number(process.env.PORT || 3000);
const STORE = process.env.DATA_PATH || '/data/cripto-ia.json';
const PERIOD = 120000;
const $ = (n) => Number(n) || 0;
const clamp = (x,a,b) => Math.min(b,Math.max(a,x));
const pause = ms => new Promise(r => setTimeout(r,ms));
const now = () => new Date().toISOString();
const origins = {spot:'Binance · velas 5m cerradas',dex:'DEX Screener · perfiles/boosts (cobertura parcial)'};
let state = {
  version:'1.0.0',startedAt:now(),running:false,scans:0,scanStarted:null,scanFinished:null,
  spot:{updatedAt:null,source:origins.spot,error:'Esperando primer escaneo',data:[]},
  dex:{updatedAt:null,source:origins.dex,error:'Esperando primer escaneo',data:[]},
  history:[]
};
try {
  const saved=JSON.parse(fs.readFileSync(STORE,'utf8'));
  if(saved && typeof saved==='object'){
    for(const kind of ['spot','dex']) if(saved[kind] && Array.isArray(saved[kind].data)) state[kind]=saved[kind];
    if(Array.isArray(saved.history)) state.history=saved.history.slice(0,300);
    state.scans=Number(saved.scans)||0;
  }
} catch(e) {if(e.code!=='ENOENT') console.warn('Historial no disponible:',e.message);}
function persist(){
  try {fs.mkdirSync(path.dirname(STORE),{recursive:true});fs.writeFileSync(STORE+'.tmp',JSON.stringify({spot:state.spot,dex:state.dex,history:state.history,scans:state.scans}));fs.renameSync(STORE+'.tmp',STORE);}
  catch(e){console.warn('No se guardó el estado:',e.message);}
}
async function json(url,timeout=15000){
  const r=await fetch(url,{headers:{accept:'application/json','user-agent':'CriptoIARadar/1.0'},signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw Error('Fuente HTTP '+r.status);
  return r.json();
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
  if(m5>=0.6 && m5<=9){score+=16;why.push('Impulso controlado 5m');}
  else if(m5>16){score-=21;risks.push('Movimiento 5m demasiado extendido');}
  else if(m5<-.5){score-=14;risks.push('Caída en 5m');}
  if(h1>=1.7 && h1<=35){score+=12;why.push('Tendencia de 1h favorable');}
  else if(h1>75){score-=17;risks.push('Subida 1h extrema');}
  else if(h1<0){score-=8;}
  if(h6>220){score-=12;risks.push('Gran extensión en 6h');}
  if(!$(p.pairCreatedAt)){blocked=true;risks.push('Edad de pool desconocida');}
  else if(age<.5){blocked=true;score-=25;risks.push('Pool menor de 30 min');}
  else if(age<3){score-=7;risks.push('Pool nuevo: alto riesgo');}
  if(!price || !liq || !count){blocked=true;risks.push('Cotización/actividad incompleta');}
  // Descubrimiento por perfiles y boosts es sesgado: nunca interpretar score como probabilidad.
  score=clamp(Math.round(score-6),0,100);
  const signal=!blocked && score>=75 && accel>=1.25 && ratio>=1.2 && m5>=.4 && m5<=12;
  const status=signal?'signal':(!blocked&&score>=52?'watch':'reject');
  const slpct=clamp(Math.max(.045,Math.abs(m5)/100*1.5),.045,.14);
  const risk=price*slpct;
  const addr=(p.baseToken&&p.baseToken.address)||p.pairAddress||'';
  const chain=p.chainId||'desconocida',id='dex:'+chain+':'+addr;
  return {id,kind:'dex',chain,name:(p.baseToken&&p.baseToken.name)||'Token',symbol:(p.baseToken&&p.baseToken.symbol)||'?',price,
    score,status,why,risks,entry:price,stop:price-risk,tp1:price+1.6*risk,tp2:price+2.4*risk,
    volume:vol5,liquidity:liq,change5:m5,change1:h1,accel:+accel.toFixed(2),buyRatio:+ratio.toFixed(2),
    url:'https://dexscreener.com/'+encodeURIComponent(chain)+'/'+encodeURIComponent(p.pairAddress||addr),
    signalKey:id+':'+Math.floor(Date.now()/900000),updatedAt:now()};
}
async function scanDex(){
  const urls=['https://api.dexscreener.com/token-profiles/latest/v1','https://api.dexscreener.com/token-boosts/latest/v1','https://api.dexscreener.com/token-boosts/top/v1'];
  const res=await Promise.allSettled(urls.map(u=>json(u)));
  const refs=res.filter(x=>x.status==='fulfilled' && Array.isArray(x.value)).flatMap(x=>x.value);
  if(!refs.length)throw Error('No se recibieron perfiles/tokens DEX');
  const groups=new Map();
  for(const t of refs){
    if(!['solana','base','ethereum'].includes(t.chainId) || !t.tokenAddress)continue;
    let a=groups.get(t.chainId)||new Set();a.add(t.tokenAddress);groups.set(t.chainId,a);
  }
  const req=[];
  for(const [chain,addresses] of groups){
    const xs=[...addresses].slice(0,90);
    for(let i=0;i<xs.length;i+=30) req.push('https://api.dexscreener.com/tokens/v1/'+chain+'/'+xs.slice(i,i+30).map(encodeURIComponent).join(','));
  }
  if(!req.length)throw Error('Sin tokens válidos para las redes admitidas');
  const raw=await Promise.allSettled(req.map(u=>json(u)));
  const all=raw.filter(x=>x.status==='fulfilled' && Array.isArray(x.value)).flatMap(x=>x.value);
  if(!all.length)throw Error('No se pudieron consultar pares DEX');
  const best=new Map();
  for(const p of all){
    if(!p || !p.baseToken || !p.baseToken.address || !['solana','base','ethereum'].includes(p.chainId))continue;
    const key=p.chainId+':'+p.baseToken.address;
    if(!best.has(key) || $(best.get(key).liquidity?.usd)<$(p.liquidity?.usd)) best.set(key,p);
  }
  const evaluated=[...best.values()].map(evaluateDex).sort((a,b)=>b.score-a.score);
  if(!evaluated.length)throw Error('DEX no devolvió datos evaluables');
  return evaluated.slice(0,100);
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
function evaluateSpot(raw,t){
  const bs=raw.map(b=>({o:$(b[1]),h:$(b[2]),l:$(b[3]),c:$(b[4]),v:$(b[5]),time:$(b[6])})).filter(b=>b.c>0 && b.h>0 && b.time<=Date.now());
  if(bs.length<75)return null;
  const last=bs[bs.length-1],older=bs.slice(0,-1),cs=bs.map(b=>b.c);
  const e20=ema(cs,20),e50=ema(cs,50),R=rsi(cs),A=atr(bs);
  const volumeBase=older.slice(-20).reduce((a,b)=>a+b.v,0)/20,vr=volumeBase?last.v/volumeBase:0;
  const peak=Math.max(...older.slice(-20).map(b=>b.h)),breakout=last.c>peak;
  const momentum=100*(last.c/bs[bs.length-4].c-1),slope=100*(e20.at(-1)/e20.at(-5)-1);
  let score=12,why=[],risks=[];
  if(e20.at(-1)>e50.at(-1) && last.c>e20.at(-1)){score+=22;why.push('EMA20 > EMA50');}else{score-=9;risks.push('Tendencia no confirmada');}
  if(slope>.05){score+=10;why.push('EMA20 ascendiendo');}else if(slope<0)score-=8;
  if(R>=52 && R<=68){score+=16;why.push('RSI de impulso controlado');}
  else if(R>76){score-=17;risks.push('RSI muy alto');}else if(R<45)score-=10;
  if(vr>=1.6){score+=20;why.push('Volumen x'+vr.toFixed(1));}else if(vr>=1.15){score+=10;}else{score-=6;risks.push('Falta volumen');}
  if(breakout){score+=18;why.push('Ruptura de máximos 20 velas');}
  else if((peak-last.c)/peak<.008){score+=6;why.push('Cerca de resistencia');}else score-=3;
  if(momentum>.2 && momentum<3.2){score+=11;why.push('Impulso 3 velas');}
  else if(momentum>7){score-=17;risks.push('Precio extendido');}
  else if(momentum<-.2)score-=6;
  const blocked=!A || $(t.quoteVolume)<5000000;
  if(blocked)risks.push('Mercado ilíquido o volatilidad insuficiente');
  score=clamp(Math.round(score),0,100);
  const signal=!blocked && score>=75 && breakout && vr>=1.15 && R<75;
  const status=signal?'signal':(!blocked&&score>=50?'watch':'reject');
  const risk=Math.max(1.5*A,last.c*.009);
  const id='spot:'+t.symbol;
  return {id,kind:'spot',chain:'Binance Spot',symbol:t.symbol.replace(/USDT$/,''),name:t.symbol,price:$(t.lastPrice)||last.c,
    score,status,why,risks,entry:last.c,stop:last.c-risk,tp1:last.c+1.7*risk,tp2:last.c+2.5*risk,
    volume:$(t.quoteVolume),change5:momentum,change1:$(t.priceChangePercent),volRatio:+vr.toFixed(2),rsi:+R.toFixed(1),
    url:'https://www.binance.com/en/trade/'+encodeURIComponent(t.symbol.replace(/USDT$/,''))+'_USDT',
    signalKey:id+':'+last.time,updatedAt:now(),candleClosedAt:new Date(last.time).toISOString()};
}
async function scanSpot(){
  const tickers=await json('https://data-api.binance.vision/api/v3/ticker/24hr',18000);
  if(!Array.isArray(tickers))throw Error('Listado Binance inválido');
  const excluded=new Set(['USDC','USDP','FDUSD','TUSD','DAI','BUSD','EUR','TRY','BRL','USDE','USD1','PAXG','XAUT']);
  const valid=tickers.filter(t=>{
    const s=t.symbol||'',base=s.replace(/USDT$/,'');
    return s.endsWith('USDT') && !excluded.has(base) && !/(UP|DOWN|BULL|BEAR)$/.test(base) && $(t.quoteVolume)>=5000000;
  });
  const byVol=[...valid].sort((a,b)=>$(b.quoteVolume)-$(a.quoteVolume)).slice(0,24);
  const byChange=[...valid].filter(t=>$(t.priceChangePercent)>0 && $(t.priceChangePercent)<35)
    .sort((a,b)=>$(b.priceChangePercent)-$(a.priceChangePercent)).slice(0,18);
  const unique=[...new Map([...byVol,...byChange].map(t=>[t.symbol,t])).values()];
  let out=[],fail=0;
  for(let i=0;i<unique.length;i+=7){
    const batch=unique.slice(i,i+7);
    const rs=await Promise.allSettled(batch.map(t=>json('https://data-api.binance.vision/api/v3/klines?symbol='+encodeURIComponent(t.symbol)+'&interval=5m&limit=110',15000)));
    for(let j=0;j<batch.length;j++){
      if(rs[j].status==='fulfilled' && Array.isArray(rs[j].value)){
        const v=evaluateSpot(rs[j].value,batch[j]);if(v)out.push(v);else fail++;
      }else fail++;
    }
    if(i+7<unique.length)await pause(350);
  }
  if(!out.length)throw Error('No se obtuvieron velas de Binance (fallas '+fail+')');
  return out.sort((a,b)=>b.score-a.score).slice(0,80);
}
function appendHistory(rows){
  const existing=new Set(state.history.map(x=>x.signalKey));
  for(const r of rows){
    if(r.status==='signal' && !existing.has(r.signalKey)){
      const {id,kind,name,symbol,chain,entry,stop,tp1,tp2,score,signalKey,url}=r;
      state.history.unshift({id,kind,name,symbol,chain,entry,stop,tp1,tp2,score,signalKey,url,detectedAt:now()});
      existing.add(signalKey);
    }
  }
  state.history=state.history.slice(0,300);
}
let busy=false;
async function cycle(){
  if(busy)return;
  busy=true;state.running=true;state.scanStarted=now();console.log('Escaneo iniciado',state.scanStarted);
  const rs=await Promise.allSettled([scanSpot(),scanDex()]);
  for(let i=0;i<rs.length;i++){
    const kind=i===0?'spot':'dex',r=rs[i];
    if(r.status==='fulfilled'){
      state[kind]={data:r.value,updatedAt:now(),source:origins[kind],error:null};
      appendHistory(r.value);
      console.log(kind,'analizados',r.value.length,'señales',r.value.filter(x=>x.status==='signal').length);
    }else {
      state[kind].error=String(r.reason && r.reason.message || r.reason);
      console.error(kind,state[kind].error);
    }
  }
  state.scans++;state.running=false;state.scanFinished=now();busy=false;persist();
}
function reply(res,code,data){
  res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','access-control-allow-origin':'*'});
  res.end(JSON.stringify(data));
}
const HTML=path.join(__dirname,'public','index.html');
http.createServer((req,res)=>{
  let u;try{u=new URL(req.url,'http://localhost');}catch{reply(res,400,{error:'URL inválida'});return;}
  if(req.method!=='GET'){reply(res,405,{error:'Sólo GET'});return;}
  if(u.pathname==='/api/health')return reply(res,200,{online:true,startedAt:state.startedAt,scans:state.scans,running:state.running,scanFinished:state.scanFinished,spotUpdatedAt:state.spot.updatedAt,dexUpdatedAt:state.dex.updatedAt});
  if(u.pathname==='/api/results')return reply(res,200,{serverTime:now(),running:state.running,scans:state.scans,scanFinished:state.scanFinished,spot:state.spot,dex:state.dex});
  if(u.pathname==='/api/history')return reply(res,200,{data:state.history});
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
