// Human-only WhatsApp pairing. Never registered as an AI/MCP tool.
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';

function qrImage(raw) {
  const qr=new QRCode(-1,1); qr.addData(raw); qr.make();
  const size=qr.getModuleCount(), side=size+8; let path='';
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(qr.isDark(y,x))path+=`M${x+4} ${y+4}h1v1h-1z`;
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="white"/><path d="${path}" fill="black"/></svg>`;
  return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}

export class WhatsAppSession {
  constructor({client,getReady,setNotReady,restartProcess,now=Date.now}) {
    Object.assign(this,{client,getReady,setNotReady,restartProcess,now});
    this.phase='initializing';this.qr=null;this.qrAt=0;this.busy=false;this.at=0;this.restarting=false;
    this.generation=0;this.failures=0;this.autoRecover=false;this.polling=false;this.stopped=false;
    client.on('qr',raw=>{this.suspend('qr');this.qr=qrImage(raw);this.qrAt=this.now();});
    client.on('authenticated',()=>{this.generation++;this.setNotReady();this.clear();this.phase='authenticating';});
    client.on('ready',()=>this.connected());
    client.on('auth_failure',()=>this.suspend('error'));
    client.on('disconnected',()=>this.suspend('disconnected'));
  }
  clear(){this.qr=null;this.qrAt=0;}
  connected(){this.clear();this.phase='connected';this.autoRecover=true;this.failures=0;}
  suspend(phase){this.generation++;this.autoRecover=false;this.setNotReady();this.clear();this.phase=phase;}
  browserAlive() {
    const {pupPage:page,pupBrowser:browser}=this.client;
    try{
      if(!browser?.isConnected()||!page||page.isClosed())return false;
      const frame=page.mainFrame();return !!frame&&!frame.detached;
    }
    catch{return false;}
  }
  isReady() {
    if(!this.getReady()||this.stopped||this.restarting)return false;
    if(this.browserAlive())return true;
    this.markUnavailable();return false;
  }
  markUnavailable(){this.setNotReady();this.phase='restarting';}
  restartOnce() {
    if(this.restarting||this.stopped)return;
    this.restarting=true;this.markUnavailable();this.restartProcess();
  }
  async monitor(probe,onReady,{timeoutMs=5000}={}) {
    if(this.polling||this.stopped||this.restarting)return;
    // A previously working session may be recovered. A new QR or an explicit
    // auth failure disables automatic recovery so pairing is never interrupted.
    if(this.busy&&this.autoRecover&&!this.qr&&this.now()-this.at>120000){this.restartOnce();return;}
    if(this.destroying)return;
    const tryRecovery=()=>{
      if(this.autoRecover&&!this.busy&&['restarting','error'].includes(this.phase)&&
         (!this.at||this.now()-this.at>=60000))this.start(true);
    };
    this.isReady();
    if(!this.browserAlive()){tryRecovery();return;}
    if(this.phase==='disconnected'||(this.phase==='error'&&!this.autoRecover))return;
    const page=this.client.pupPage,generation=this.generation;
    let timer;
    this.polling=true;
    try {
      let ok=false;
      try {
        ok=await Promise.race([probe(page),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);
      } catch {/* Chromium may be navigating or the renderer may have died. */}
      if(this.stopped||this.restarting||generation!==this.generation||page!==this.client.pupPage)return;
      if(ok&&this.browserAlive()){
        this.failures=0;
        if(!this.isReady()){this.connected();onReady();}
      }else if(++this.failures>=3&&this.getReady()){
        this.markUnavailable();
      }
      tryRecovery();
    } finally {clearTimeout(timer);this.polling=false;}
  }
  snapshot() {
    const connected=this.isReady();
    if(connected&&this.phase!=='connected')this.connected();
    const valid=!!this.qr&&this.now()-this.qrAt<45000;
    const phase=this.phase==='qr'&&!valid?'expired':!connected&&this.phase==='connected'?'restarting':this.phase;
    const messages={connected:'WhatsApp conectado. Você já pode usar esta conta.',qr:'No celular, abra WhatsApp → Aparelhos conectados → Conectar aparelho e escaneie este código.',
      expired:'O código expirou. Aguarde o próximo código ou clique em Gerar QR Code.',initializing:'Preparando a conexão. Aguarde o QR Code aparecer.',
      authenticating:'Celular reconhecido. Sincronizando o WhatsApp…',disconnected:'WhatsApp desconectado. Clique em Gerar QR Code para reconectar.',
      restarting:'Recuperando a sessão. Aguarde alguns instantes.',error:'Não foi possível preparar a sessão. Clique em Gerar QR Code para tentar novamente.'};
    return {success:true,state:phase,connected:phase==='connected',qr_image:valid?this.qr:null,
      expires_at:valid?new Date(this.qrAt+45000).toISOString():null,message:messages[phase]||messages.error};
  }
  start(recover=false) {
    if(this.busy||this.stopped||this.restarting)return;
    this.busy=true;this.generation++;this.at=this.now();this.clear();this.phase='initializing';
    this.operation=(async()=>{
      try {
        if(recover){this.setNotReady();this.destroying=true;try{await this.client.destroy();}finally{this.destroying=false;}}
        if(this.stopped||this.restarting)return;
        await this.client.initialize();
      } catch {this.setNotReady();this.clear();this.phase='error';}
      finally {this.busy=false;}
    })();
  }
  reconnect() {
    const state=this.snapshot();
    // Opening the dialog never logs out or interrupts an already connected account.
    if(state.connected||state.qr_image||this.phase==='authenticating')return state;
    if(this.busy){
      if(this.now()-this.at>120000)this.restartOnce();
      return this.snapshot();
    }
    if(this.now()-this.at<15000&&this.at)return state;
    this.start(true);return this.snapshot();
  }
}

export function registerSessionRoutes(app,{session,authorize,limiter,instance,displayName,audit}) {
  const noCache=(req,res,next)=>{res.set('Cache-Control','no-store');res.set('Pragma','no-cache');next();};
  const result=()=>({...session.snapshot(),instance,instance_display_name:displayName});
  app.get('/api/whatsapp-session',noCache,authorize,limiter,(req,res)=>res.json(result()));
  app.post('/api/whatsapp-session/reconnect',noCache,authorize,limiter,(req,res)=>{
    if(req.body?.instance!==instance)return res.status(409).json({success:false,message:'A instância não corresponde à conta selecionada.'});
    session.reconnect();audit({action:'whatsapp_session_reconnect',identityId:req.auth.extra.identityId});
    res.status(202).json(result());
  });
}
