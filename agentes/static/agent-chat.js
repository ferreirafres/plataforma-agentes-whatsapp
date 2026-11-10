'use strict';
function openAgentChat(id){return openManagementChat(id,'agent');}
function openModalChat(id){return openManagementChat(id,'modal');}
async function openManagementChat(id,kind){
  const modal=kind==='modal',record=(modal?state.modals:state.agents).find(a=>a.id===id);if(!record)return;
  const path=`${modal?'agent-modals':'agents'}/${id}/chat`;
  const dialog=document.createElement('dialog');dialog.className='editor agent-chat-dialog';
  const prompts=modal?[['Ajustar a base','Quero melhorar a identidade e o contexto deste modal. Mostre como estão e pergunte o que preciso ajustar.'],['Criar agente','Quero criar um novo agente neste modal. Me ajude a definir o objetivo, as instruções e as tags necessárias.']]:[['Diagnosticar','Explique por que está aguardando e o que falta para concluir.'],['Reavaliar fila','Reavalie agora os contatos da fila conforme o objetivo atual, sem repetir comunicados já enviados.'],['Pausar','Pause este agente agora.'],['Retomar','Retome este agente agora.']];
  dialog.innerHTML=`<div class="agent-chat-shell"><header><div><span class="eyebrow">${modal?'CONVERSAR COM O MODAL':'CONVERSAR COM O AGENTE'}</span><h2>${esc(record.name)}</h2></div><button type="button" class="icon-btn chat-close" aria-label="Fechar conversa">×</button></header><p class="field-help">${modal?'Ajuste a identidade e o contexto compartilhados ou descreva uma atividade para criar uma nova etapa com suas tags.':'Peça para editar objetivo e instruções, diagnosticar, pausar ou retomar. Alterações ficam salvas e o agente ligado passa a segui-las.'} Você verá o antes e depois de cada alteração.</p><div class="chat-diagnostic" role="status">Consultando ${modal?'modal':'fila'}…</div><details class="chat-current"><summary>${modal?'Identidade e contexto atuais':'Objetivo, instruções e orientações salvas'}</summary><div class="chat-configuration"></div>${modal?'':'<p class="chat-notes"></p>'}</details><div class="chat-messages" role="log" aria-live="polite" aria-label="Conversa com ${modal?'o modal':'o agente'}"></div><div class="chat-shortcuts">${prompts.map(([label,prompt])=>`<button type="button" class="btn secondary" data-prompt="${esc(prompt)}">${esc(label)}</button>`).join('')}</div><form class="chat-form"><label>Mensagem ${modal?'ao modal':'ao agente'}<textarea name="message" maxlength="6000" rows="3" required placeholder="Descreva o que quer ajustar ou grave um áudio…"></textarea></label><div class="chat-audio-actions"><button type="button" class="btn secondary chat-record">Gravar áudio</button><label class="btn secondary chat-audio-label">Anexar áudio<input type="file" class="chat-audio-file" accept="audio/*,.webm,.ogg,.mp3,.m4a,.mp4,.wav,.flac,.mpeg,.mpga"></label><button type="button" class="btn secondary chat-cancel-record" hidden>Descartar gravação</button><span class="chat-audio-status" role="status" aria-live="polite"></span></div><audio class="chat-audio-preview" controls hidden></audio><p class="field-help">Grave até 5 minutos ou anexe um áudio de até 12 MB. O áudio vira texto para você revisar e enviar.</p><p class="chat-error form-error" role="alert"></p><button type="submit" class="btn primary chat-send">Enviar</button></form></div>`;
  document.body.append(dialog);dialog.showModal();
  const log=dialog.querySelector('.chat-messages'),input=dialog.querySelector('textarea'),form=dialog.querySelector('form'),errorBox=dialog.querySelector('.chat-error');
  let pending=false,audioBusy=false,alive=true,recorder=null,stream=null,timer=null,discard=false,recordStarting=false,audioURL=null,controller=null;
  const send=form.querySelector('.chat-send'),recordButton=form.querySelector('.chat-record'),fileInput=form.querySelector('.chat-audio-file'),cancelRecord=form.querySelector('.chat-cancel-record'),audioStatus=form.querySelector('.chat-audio-status'),preview=form.querySelector('audio');
  const controls=()=>{send.disabled=pending||audioBusy||recordStarting||!!recorder;recordButton.disabled=pending||audioBusy||recordStarting;fileInput.disabled=pending||audioBusy||recordStarting||!!recorder;};
  const append=(role,text,changes=[])=>{if(!alive)return;const item=document.createElement('div');item.className='chat-bubble '+role;const title=document.createElement('strong');title.textContent=role==='user'?'Você':modal?'IA do modal':'Agente IA';const body=document.createElement('p');body.textContent=text;item.append(title,body);
    for(const change of changes){const details=document.createElement('details');details.className='chat-change';const summary=document.createElement('summary');summary.textContent=({objective:'Objetivo',instructions:'Instruções',identity:'Identidade',context:'Contexto'}[change.field]||change.field)+(change.field==='Novo agente'?' · criado':' · alterado');details.append(summary);for(const [label,key] of [['Antes','before'],['Depois','after']]){const heading=document.createElement('strong');heading.textContent=label;const value=document.createElement('pre');value.textContent=change[key]||'(vazio)';details.append(heading,value);}details.open=String(change.before).length+String(change.after).length<1200;item.append(details);}
    log.append(item);log.scrollTop=log.scrollHeight;
  };
  const load=async(initial=false)=>{const result=await api(path);if(!alive)return;
    const d=result.diagnostic;dialog.querySelector('.chat-diagnostic').textContent=modal?`${d.agents?.length||0} agente(s) · ${d.whatsapp||''}${d.consultation_error?' · '+d.consultation_error:''}`:`${d.enabled?'Ligado':'Desligado'} · ${d.eligible_count??'Não foi possível consultar'} contato(s) elegíveis · ${d.worker_available?'Serviço disponível':'Serviço sem atualização recente'}${d.consultation_error?' · '+d.consultation_error:''}${d.reason?' · '+d.reason:''}`;
    if(!modal)dialog.querySelector('.chat-notes').textContent=result.notes||'Nenhuma orientação adicional salva.';
    const config=dialog.querySelector('.chat-configuration');config.replaceChildren();
    for(const [key,text] of Object.entries(result.configuration||{})){const label=document.createElement('strong');label.textContent=({objective:'Objetivo',instructions:'Instruções',identity:'Identidade',context:'Contexto'}[key]||key);const p=document.createElement('p');p.textContent=text||'(vazio)';config.append(label,p);}
    if(modal&&d.labels){const label=document.createElement('strong');label.textContent='Etiquetas disponíveis';const p=document.createElement('p');p.textContent=d.labels.map(l=>l.name).join(' · ');config.append(label,p);}
    if(initial){for(const item of result.messages)append(item.role,item.body,item.changes||[]);if(!result.messages.length)append('assistant',modal?'Descreva o que deseja melhorar na base ou a nova atividade que quer adicionar.':'Estou pronto para consultar meu estado e ajustar meu objetivo e minhas instruções com você.');}
  };
  const releaseStream=()=>{stream?.getTracks().forEach(track=>track.stop());stream=null;clearInterval(timer);timer=null;};
  const transcribeAudio=async blob=>{
    if(!alive)return;if(blob.size>12*1024*1024){errorBox.textContent='O áudio ultrapassa 12 MB. Envie um arquivo menor.';return;}if(!blob.size){errorBox.textContent='O áudio está vazio. Grave novamente.';return;}
    audioBusy=true;controls();errorBox.textContent='';audioStatus.textContent='Transcrevendo áudio…';controller=new AbortController();
    if(audioURL)URL.revokeObjectURL(audioURL);audioURL=URL.createObjectURL(blob);preview.src=audioURL;preview.hidden=false;
    try{const data=new FormData();const extension=blob.type.includes('mp4')?'m4a':blob.type.includes('ogg')?'ogg':'webm';data.append('audio',blob,blob.name||`gravacao.${extension}`);
      const response=await fetch('/api/'+path+'/transcribe',{method:'POST',headers:{'X-CSRF-Token':csrf},body:data,signal:controller.signal});const result=await response.json();if(!response.ok)throw new Error(result.error||'Não foi possível transcrever.');
      if(!alive)return;const text=[input.value.trim(),result.text].filter(Boolean).join('\n');if(text.length>6000)throw new Error('O texto com a transcrição ultrapassa 6.000 caracteres. Envie um áudio menor.');input.value=text;audioStatus.textContent='Transcrição pronta. Revise e envie.';input.focus();
    }catch(error){if(alive&&error.name!=='AbortError'){errorBox.textContent=error.message;audioStatus.textContent='A transcrição não foi enviada ao chat.';}}
    finally{audioBusy=false;controller=null;controls();}
  };
  fileInput.onchange=async()=>{const file=fileInput.files[0];fileInput.value='';if(file)await transcribeAudio(file);};
  recordButton.onclick=async()=>{
    if(recorder){recorder.stop();return;}if(recordStarting||audioBusy||pending)return;
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){errorBox.textContent='Seu navegador não permite gravar aqui. Use Anexar áudio.';return;}
    recordStarting=true;controls();errorBox.textContent='';
    try{stream=await navigator.mediaDevices.getUserMedia({audio:true});if(!alive){releaseStream();return;}
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
      const recording=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);recorder=recording;const chunks=[];let size=0,seconds=0;discard=false;
      recording.ondataavailable=event=>{if(event.data.size){chunks.push(event.data);size+=event.data.size;if(size>12*1024*1024&&recording.state==='recording'){discard=true;recording.stop();errorBox.textContent='Gravação muito grande. Grave um áudio menor.';}}};
      recording.onerror=()=>{discard=true;errorBox.textContent='Não foi possível concluir a gravação. Tente novamente.';if(recording.state!=='inactive')recording.stop();else{releaseStream();recorder=null;recordButton.textContent='Gravar áudio';cancelRecord.hidden=true;controls();}};
      recording.onstop=()=>{releaseStream();recorder=null;recordButton.textContent='Gravar áudio';cancelRecord.hidden=true;audioStatus.textContent=discard?'Gravação descartada.':'';controls();if(alive&&!discard)transcribeAudio(new Blob(chunks,{type:recording.mimeType||mime||'audio/webm'}));};
      recording.start(1000);recordButton.textContent='Parar e transcrever';cancelRecord.hidden=false;audioStatus.textContent='Gravando · 0:00';
      timer=setInterval(()=>{seconds++;audioStatus.textContent=`Gravando · ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;if(seconds>=300&&recording.state==='recording')recording.stop();},1000);
    }catch(error){releaseStream();recorder=null;errorBox.textContent=error.name==='NotAllowedError'?'O microfone não foi autorizado. Libere o acesso no navegador ou anexe um áudio.':'Não foi possível acessar o microfone. Você pode anexar um áudio.';}
    finally{recordStarting=false;controls();}
  };
  cancelRecord.onclick=()=>{discard=true;if(recorder?.state==='recording')recorder.stop();};
  dialog.querySelector('.chat-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{alive=false;discard=true;controller?.abort();if(recorder?.state==='recording')recorder.stop();releaseStream();preview.pause();preview.removeAttribute('src');if(audioURL)URL.revokeObjectURL(audioURL);dialog.remove();});
  dialog.querySelectorAll('[data-prompt]').forEach(button=>button.onclick=()=>{input.value=button.dataset.prompt;input.focus();});
  form.onsubmit=async event=>{event.preventDefault();if(pending||audioBusy||recorder||!input.value.trim())return;pending=true;const message=input.value.trim();controls();send.textContent='Respondendo…';errorBox.textContent='';
    try{const result=await api(path,'POST',{message});append('user',message);append('assistant',result.reply,result.changes||[]);input.value='';await refresh();await load();}
    catch(error){if(alive)errorBox.textContent=error.message;}finally{pending=false;controls();send.textContent='Enviar';}
  };
  try{await load(true);}catch(error){if(alive)dialog.querySelector('.chat-diagnostic').textContent=error.message;}
}
