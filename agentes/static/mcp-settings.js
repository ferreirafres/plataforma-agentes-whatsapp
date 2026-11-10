/* Credentials live only inside the open dialog and are cleared when it closes. */
window.MCPSettings = (() => {
  const list=document.querySelector('#mcp-connections-list');
  const dialog=document.querySelector('#mcp-credentials-dialog');
  const form=dialog.querySelector('form');
  const policies={always:'Permitir sempre · sem vencimento',hour:'Permitir por 1 hora',day:'Permitir por 24 horas',week:'Permitir por 7 dias',month:'Permitir por 30 dias',disabled:'Não permitir'};
  let items=[],busy=false,selected=null,generation=0;
  const date=value=>value?new Date(value).toLocaleString('pt-BR'):'Sem vencimento';
  async function load(){
    if(busy)return;
    busy=true;
    try{
      const result=await api('mcp-connections');items=result.connections;
      list.innerHTML=items.length?items.map(item=>{
        const status=item.status||{};
        const label=!item.managed?'Indisponível':!item.enabled?'Bloqueado':!item.authorized?'Autorização expirada':status.connected?'Conectado':status.authenticated?'WhatsApp desconectado':'Reconexão necessária';
        return `<article class="mcp-connection"><div class="mcp-connection-head"><div><h3>${esc(item.name)}</h3><p class="muted mcp-endpoint">${esc(item.endpoint)}/mcp</p></div><span class="pending-chip ${status.connected?'connected-chip':''}">${label}</span></div><p class="muted">${esc(item.error||status.message||'')}</p>${item.managed?`<dl class="mcp-facts"><div><dt>Usuário MCP</dt><dd>${esc(item.login)}</dd></div><div><dt>Autorização no servidor</dt><dd>${esc(policies[item.policy]||item.policy)}</dd></div><div><dt>Vencimento</dt><dd>${esc(date(item.authorization_expires_at))}</dd></div><div><dt>Último uso da autorização</dt><dd>${esc(item.last_used_at?date(item.last_used_at):'Ainda não registrado')}</dd></div></dl><div class="mcp-actions"><button type="button" class="btn secondary" data-mcp-action="edit" data-id="${esc(item.id)}">Login, senha e autorização</button><button type="button" class="btn secondary" data-mcp-action="reconnect" data-id="${esc(item.id)}" ${!item.authorized?'disabled':''}>Reconectar MCP</button></div>`:''}</article>`;
      }).join(''):'<p class="muted">Nenhuma conexão MCP configurada.</p>';
    }catch(error){list.textContent=error.message;}finally{busy=false;}
  }
  function close(){generation++;selected=null;form.reset();form.querySelector('#mcp-current-password').textContent='••••••••';form.querySelector('#mcp-current-credentials').hidden=true;form.querySelector('#mcp-save-error').textContent='';}
  list.addEventListener('click',async event=>{
    const button=event.target.closest('[data-mcp-action]');if(!button)return;
    const item=items.find(i=>i.id===button.dataset.id);if(!item)return;
    if(button.dataset.mcpAction==='edit'){
      close();selected=item;
      form.querySelector('#mcp-dialog-title').textContent=item.name;
      form.elements.login.value=item.login;
      form.elements.policy.value=item.policy;
      dialog.showModal();return;
    }
    button.disabled=true;
    try{await api(`mcp-connections/${item.id}/reconnect`,'POST',{});await load();toast('Autorização MCP renovada.');}
    catch(error){toast(error.message,true);}finally{button.disabled=false;}
  });
  form.querySelector('#mcp-reveal').addEventListener('click',async event=>{
    if(!selected)return;
    const current=selected.id,stamp=generation,button=event.currentTarget;
    button.disabled=true;
    try{
      const result=await api(`mcp-connections/${current}/reveal`,'POST',{});
      if(!dialog.open||stamp!==generation)return;
      form.querySelector('#mcp-current-login').textContent=result.login;
      form.querySelector('#mcp-current-password').textContent=result.password||'Senha anterior não recuperável. Defina uma nova abaixo.';
      form.querySelector('#mcp-current-credentials').hidden=false;
    }catch(error){if(stamp===generation)form.querySelector('#mcp-save-error').textContent=error.message;}
    finally{button.disabled=false;}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!selected)return;
    const button=form.querySelector('[type=submit]'),stamp=generation;
    button.disabled=true;form.querySelector('#mcp-save-error').textContent='';
    try{
      const result=await api(`mcp-connections/${selected.id}/update`,'POST',Object.fromEntries(new FormData(form)));
      if(stamp===generation)dialog.close();
      toast(result.warning||'Login e autorização MCP salvos.',!!result.warning);await load();
    }catch(error){if(stamp===generation)form.querySelector('#mcp-save-error').textContent=error.message;}
    finally{button.disabled=false;}
  });
  dialog.querySelector('#mcp-dialog-close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',close);
  document.querySelector('#check-mcp-connections').addEventListener('click',load);
  setInterval(()=>{if(!document.querySelector('#settings-view').hidden&&!dialog.open)load();},60000);
  return {load,clear:()=>{dialog.close();close();items=[];list.textContent='';}};
})();
