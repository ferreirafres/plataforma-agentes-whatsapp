'use strict';

async function openContactList({agentId,name='',changes={add:[],remove:[]},onSave}={}){
  let dialog=$('#contacts-dialog');
  if(!dialog){dialog=document.createElement('dialog');dialog.id='contacts-dialog';dialog.className='contacts-dialog';document.body.append(dialog);}
  const draft={add:(changes.add||[]).map(c=>({...c})),remove:[...(changes.remove||[])]};
  let rows=[],nextOffset=0,total=0,busy=false,visible=100;
  const statuses={pending:'Aguardando agente',queued:'No atendimento',completed:'Finalizado / já atendido',error:'Conferir número'};
  dialog.innerHTML=`<form id="contacts-form"><header class="modal-header"><div><span class="eyebrow">LISTA DE CONTATOS</span><h2>${esc(name||'Contatos do agente')}</h2><p class="muted">Cadastre um contato ou importe vários nomes e números.</p></div><button type="button" class="icon-btn" id="contacts-close" aria-label="Fechar lista">${icon('close')}</button></header><div class="contacts-body">
  <p class="field-help">O agente ligado adiciona a tag de entrada aos contatos desta lista e inicia o atendimento, junto dos contatos que já possuem a tag. Números repetidos não geram novos envios. Use DDD; para outros países, inclua +DDI.</p>
  <div class="contact-manual"><label>Nome<input id="contact-name" maxlength="120" placeholder="Nome do contato"></label><label>Telefone<input id="contact-phone" type="tel" maxlength="30" placeholder="(11) 99999-9999 ou +55..."></label><button type="button" class="btn secondary" id="contact-add">${icon('plus')}Adicionar</button></div>
  <details class="contact-import"><summary>Importar números com IA</summary><label>Texto com os nomes e números<textarea id="contact-import-text" rows="5" placeholder="Cole sua lista aqui. A IA organizará os nomes e telefones para você revisar."></textarea></label><div class="contact-import-actions"><label class="contact-file">Arquivo de texto<input id="contact-file" type="file" accept=".txt,text/plain"></label><button type="button" class="btn secondary" id="contact-extract">Extrair contatos</button></div><p class="field-help">O conteúdo será enviado à IA para extração. Revise a lista antes de salvar.</p></details>
  <p id="contact-progress" class="field-help" role="status"></p><div class="contacts-list-heading"><strong id="contacts-total"></strong><span class="field-help">Sem lista, segue somente pelas tags.</span></div><div id="contacts-rows"></div><button type="button" class="btn secondary" id="contacts-more" hidden>Mostrar mais contatos</button>
  <p class="field-help">Remover da lista não apaga a conversa nem retira etiquetas já aplicadas. O nome é usado neste atendimento e não altera a agenda do WhatsApp.</p><p class="form-error" id="contacts-error" role="alert"></p></div><footer class="modal-footer"><span class="modal-footer-note">${onSave?'Alterações serão aplicadas ao salvar o modal.':'Somente agentes ligados processam a lista.'}</span><div class="actions"><button type="button" class="btn secondary" id="contacts-cancel">Cancelar</button><button type="submit" class="btn primary" id="contacts-save">Salvar lista</button></div></footer></form>`;
  dialog.showModal();
  const root=selector=>$(selector,dialog);
  const snapshot=()=>JSON.stringify(draft);
  let original=snapshot();
  function render(){
    const existing=rows.filter(row=>!draft.remove.includes(row.id));
    const addedPhones=new Set(draft.add.map(row=>row.phone));
    const items=[...draft.add.map((row,i)=>({...row,draftIndex:i,status:'new'})),...existing.filter(row=>!addedPhones.has(row.phone))];
    root('#contacts-total').textContent=`${Math.max(0,total-draft.remove.length)+draft.add.filter(row=>!rows.some(old=>old.phone===row.phone)).length} contato(s)`;
    root('#contacts-rows').innerHTML=items.slice(0,visible).map(row=>`<div class="contact-row"><div>${row.draftIndex===undefined?`<strong>${esc(row.name||'Sem nome')}</strong><span>+${esc(row.phone)}</span>`:`<div class="contact-draft-fields"><input aria-label="Nome do contato importado" data-contact-edit="${row.draftIndex}" data-contact-field="name" maxlength="120" value="${esc(row.name)}"><input aria-label="Telefone do contato importado" data-contact-edit="${row.draftIndex}" data-contact-field="phone" type="tel" value="${esc(row.phone.startsWith('+')?row.phone:'+'+row.phone)}"></div>`}<small>${esc(row.status==='new'?'Novo · ainda não salvo':statuses[row.status]||row.status)}${row.result_tag?` · ${esc(row.result_tag)}`:''}</small>${row.error?`<small class="contact-row-error">${esc(row.error)}</small>`:''}</div><button type="button" class="icon-btn" data-contact-remove="${row.draftIndex===undefined?esc(row.id):'draft-'+row.draftIndex}" aria-label="Remover ${esc(row.name||row.phone)}">${icon('trash')}</button></div>`).join('')||'<p class="field-help">Nenhum contato nesta lista.</p>';
    root('#contacts-more').hidden=nextOffset===null&&items.length<=visible;
  }
  async function load(){
    if(!agentId){nextOffset=null;render();return;}
    const result=await api(`agents/${agentId}/contacts?offset=${nextOffset||0}`);
    rows.push(...result.contacts);total=result.total;nextOffset=result.next_offset;render();
  }
  function normalize(value){
    if(!/^[+()\d\s.\-]+$/.test(value.trim()))throw new Error('Informe um telefone válido.');
    let digits=value.replace(/\D/g,'');
    if(digits.startsWith('00')&&!value.trim().startsWith('+'))digits=digits.slice(2);
    else if(!value.trim().startsWith('+')&&[10,11].includes(digits.length))digits='55'+digits;
    if(digits.length<10||digits.length>15||digits.startsWith('0')||new Set(digits).size<3)throw new Error('Informe telefone com DDD; para outros países, use +DDI.');
    return digits;
  }
  function add(items){
    const known=new Set([...rows.filter(row=>!draft.remove.includes(row.id)),...draft.add].map(row=>row.phone));
    for(const item of items){const phone=normalize(item.phone);if(!known.has(phone)){draft.add.push({name:item.name?.trim()||'',phone});known.add(phone);}}
    render();
  }
  async function close(){
    if(busy)return;
    if(snapshot()!==original&&!await confirmAction('Descartar alterações da lista?','Os contatos adicionados ou removidos ainda não foram salvos.','Descartar',true))return;
    dialog.close();
  }
  root('#contacts-close').onclick=close;root('#contacts-cancel').onclick=close;
  dialog.oncancel=event=>{event.preventDefault();close();};
  root('#contact-add').onclick=()=>{
    root('#contacts-error').textContent='';
    try{add([{name:root('#contact-name').value,phone:root('#contact-phone').value}]);root('#contact-name').value='';root('#contact-phone').value='';root('#contact-name').focus();}catch(error){root('#contacts-error').textContent=error.message;}
  };
  root('#contacts-rows').onclick=event=>{
    const button=event.target.closest('[data-contact-remove]');if(!button||busy)return;
    const id=button.dataset.contactRemove;
    if(id.startsWith('draft-'))draft.add.splice(Number(id.slice(6)),1);else draft.remove.push(id);
    render();
  };
  root('#contacts-rows').oninput=event=>{const input=event.target;if(input.dataset.contactEdit!==undefined)draft.add[Number(input.dataset.contactEdit)][input.dataset.contactField]=input.value;};
  root('#contacts-more').onclick=async()=>{try{visible+=100;if(nextOffset!==null)await load();else render();}catch(error){root('#contacts-error').textContent=error.message;}};
  root('#contact-file').onchange=async event=>{
    const file=event.target.files[0];if(!file)return;
    if(file.size>1024*1024){root('#contacts-error').textContent='Importe arquivos de texto de até 1 MB por vez.';return;}
    const bytes=await file.arrayBuffer();let text;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('windows-1252').decode(bytes);}
    root('#contact-import-text').value=text.replace(/^\uFEFF/,'');
  };
  root('#contact-extract').onclick=async()=>{
    if(busy)return;let text=root('#contact-import-text').value.trim();if(!text){root('#contacts-error').textContent='Cole o texto ou selecione um arquivo primeiro.';return;}
    busy=true;root('#contacts-error').textContent='';root('#contact-extract').disabled=true;root('#contacts-save').disabled=true;
    try{
      let batches=0;
      while(text){
        let end=Math.min(6000,text.length);
        if(end<text.length){const boundary=text.lastIndexOf('\n',end);if(boundary>1000)end=boundary;else{const space=text.lastIndexOf(' ',end);if(space>1000)end=space;}}
        const chunk=text.slice(0,end);text=text.slice(end).trimStart();
        root('#contact-progress').textContent=`Extraindo contatos… lote ${++batches}`;
        const result=await api('contacts/parse','POST',{text:chunk});add(result.contacts);
      }
      root('#contact-progress').textContent='Extração concluída. Revise os nomes e números antes de salvar.';
    }catch(error){root('#contacts-error').textContent=error.message;root('#contact-progress').textContent='Os contatos já extraídos foram mantidos para revisão.';}finally{busy=false;root('#contact-extract').disabled=false;root('#contacts-save').disabled=false;}
  };
  root('#contacts-form').onsubmit=async event=>{
    event.preventDefault();if(busy)return;busy=true;root('#contacts-save').disabled=true;root('#contacts-error').textContent='';
    try{
      if(root('#contact-phone').value.trim()){add([{name:root('#contact-name').value,phone:root('#contact-phone').value}]);root('#contact-phone').value='';}
      draft.add=draft.add.map(row=>({name:row.name.trim(),phone:normalize(row.phone)}));
      if(onSave){if(draft.add.length>1000||draft.remove.length>1000)throw new Error('Salve o modal com até 1.000 alterações. Depois, use Lista de Contatos no cartão para importar mais lotes.');await onSave(draft);}
      else{
        let batch=0;
        while(draft.add.length||draft.remove.length){
          root('#contact-progress').textContent=`Salvando lista… lote ${++batch}`;
          const result=await api(`agents/${agentId}/contacts`,'POST',{add:draft.add.slice(0,1000),remove:draft.remove.slice(0,1000)});
          draft.add.splice(0,1000);draft.remove.splice(0,1000);total=result.total;
        }
        await refresh();toast('Lista salva. O agente ligado incluirá os contatos na tag de entrada.');
      }
      original=snapshot();dialog.close();
    }catch(error){root('#contacts-error').textContent=error.message;}finally{busy=false;root('#contacts-save').disabled=false;}
  };
  try{await load();}catch(error){root('#contacts-error').textContent=error.message;}
}
