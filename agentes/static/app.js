'use strict';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let csrf = '', state = {boards:[], columns:[], agents:[], modals:[], whatsapps:[]}, view = 'board', search = '', toastTimer;
let activeBoard = localStorage.getItem('active-board') || '', installPrompt;
const currentBoard = () => state.boards.find(b=>b.id===activeBoard);
const boardColumns = () => state.columns.filter(c=>c.board_id===activeBoard);
const boardAgents = () => state.agents.filter(a=>boardColumns().some(c=>c.id===a.column_id));
const boardModals = () => (state.modals||[]).filter(m=>boardColumns().some(c=>c.id===m.column_id));
const modalAgents = id => state.agents.filter(a=>a.modal_id===id).sort((a,b)=>a.flow_position-b.flow_position);
let editorSnapshot = '', saving = false;

async function api(path, method='GET', data) {
  const response = await fetch('/api/' + path, {method, headers: {'Content-Type':'application/json', 'X-CSRF-Token':csrf}, ...(data === undefined ? {} : {body:JSON.stringify(data)})});
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== 'login') { $('#editor').close(); showLogin(); }
    throw new Error(result.error || 'Não foi possível concluir. Tente novamente.');
  }
  if (result.csrf) csrf = result.csrf;
  return result;
}
function toast(message, error=false) {
  clearTimeout(toastTimer); const box = $('#toast'); box.textContent = message; box.hidden = false; box.classList.toggle('error', error);
  toastTimer = setTimeout(() => {box.hidden=true;}, error ? 7000 : 4500);
}
function showLogin(){ window.MCPSettings?.clear(); $('#loading').hidden=true; $('#workspace').hidden=true; $('#login').hidden=false; }
async function refresh() {state = await api('state'); if(!currentBoard())activeBoard=state.boards[0]?.id||''; renderBoards(); renderBoard(); renderWhatsapps();}
async function showWorkspace(){ await refresh(); $('#loading').hidden=true; $('#login').hidden=true; $('#workspace').hidden=false; }
function changeView(name) {
  if(name==='settings')window.MCPSettings?.load();
  view=name; $('#board-view').hidden = name !== 'board'; $('#settings-view').hidden = name !== 'settings';
  $$('.nav-item').forEach(el=>el.classList.toggle('selected',el.dataset.view===name));
  $('#breadcrumb').textContent=name==='board'?'Meus agentes':'Configurações';
}
const emptyIllustration = `<div class="empty-illustration" aria-hidden="true"><div class="illustration-card"></div><div class="illustration-card front">${icon('spark')}<div class="illustration-line"></div><div class="illustration-line short"></div></div><div class="illustration-badge">${icon('plus')}</div></div>`;
function renderBoards(){
  $('#board-select').innerHTML=state.boards.map(b=>`<option value="${b.id}" ${b.id===activeBoard?'selected':''}>${esc(b.name)}</option>`).join('');
  $('#board-select').disabled=!state.boards.length;
  $('#edit-board').disabled=!currentBoard(); $('#new-column').disabled=!currentBoard();
  const whatsapp=state.whatsapps.find(w=>w.id===currentBoard()?.whatsapp_id);
  $('#board-account').textContent=whatsapp?.name||'WhatsApp escolhido em cada agente';
}
function openBoard(id){
  const board=state.boards.find(b=>b.id===id);
  openEditor({title:board?'Editar quadro':'Novo quadro',subtitle:'Um espaço para organizar os agentes de um WhatsApp.',small:true,submit:board?'Salvar alterações':'Criar quadro',deleteLabel:board?'Excluir':'',body:`<label>Nome do quadro<input name="name" required maxlength="100" placeholder="Ex.: Meu quadro" value="${esc(board?.name||'')}"></label><label>WhatsApp do quadro<select name="whatsapp_id" ${board?.whatsapp_id?'':'required'}><option value="">Selecionar WhatsApp</option>${state.whatsapps.map(w=>`<option value="${w.id}" ${board?.whatsapp_id===w.id?'selected':''}>${esc(w.name)}</option>`).join('')}</select><span class="field-help">Os agentes deste quadro usam essa conta. Para trocar a conta de um quadro com agentes, crie outro quadro.</span></label>`});
  bindSave(async data=>{const result=await api(board?`boards/${id}`:'boards',board?'PUT':'POST',data);activeBoard=result.id;localStorage.setItem('active-board',activeBoard);},board?'Quadro atualizado.':'Quadro criado. Adicione sua primeira coluna.');
  if(board)bindDelete(`boards/${id}`,'Excluir quadro?',`Remova primeiro as colunas do quadro “${board.name}”.`,'Quadro excluído.');
}
function renderBoard(){
  const columns=boardColumns(), agents=boardModals();
  $('#agent-count').textContent = agents.length;
  $('#agent-count').title = `${agents.length} modais · ${boardAgents().length} agentes`;
  const connected=state.whatsapps.filter(w=>w.connected).length;
  $('#integration-status').textContent=connected?`${connected} WhatsApp${connected>1?'s':''} conectado${connected>1?'s':''} · OpenAI ${state.brain?.verified?'conectada':'aguardando verificação'} · ${state.execution_ready?'serviço de agentes disponível':'serviço de agentes iniciando'}.`:'WhatsApp MCP · Nenhuma sessão conectada no momento. Confira em Configurações.';
  if(!currentBoard()){
    $('#board').innerHTML=`<div class="empty-board">${emptyIllustration}<h2>Crie seu primeiro quadro.</h2><p>Escolha um WhatsApp e organize seus agentes.</p><button class="btn primary" data-action="new-board">${icon('plus')}Criar quadro</button></div>`;return;
  }
  if (!columns.length){
    $('#board').innerHTML=`<div class="empty-board">${emptyIllustration}<h2>Seu próximo agente começa aqui.</h2><p>Crie sua primeira coluna para organizar os agentes por propósito. O resto, você constrói aos poucos.</p><button class="btn primary" data-action="new-column">${icon('plus')}Criar primeira coluna</button><span class="empty-tip">Um quadro em branco. Muitas possibilidades.</span></div>`;
    return;
  }
  const filtered = agents.filter(a=>[a.name,a.description,...modalAgents(a.id).flatMap(s=>[s.name,s.objective,s.target_tag,s.exit_tag])].join(' ').toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')));
  $('#board').innerHTML=`<div class="kanban">${columns.map((col,index)=>{
    const cards=filtered.filter(a=>a.column_id===col.id);
    return `<section class="column" data-id="${col.id}" data-color="${col.color}" aria-label="${esc(col.name)}"><header class="column-header"><span class="column-dot"></span><h2>${esc(col.name)}</h2><span class="count">${agents.filter(a=>a.column_id===col.id).length}</span><div class="column-actions">${index ? `<button class="icon-btn" data-action="column-left" data-id="${col.id}" title="Mover coluna para a esquerda" aria-label="Mover coluna para a esquerda">${icon('arrow')}</button>`:''}<button class="icon-btn" data-action="edit-column" data-id="${col.id}" title="Editar coluna" aria-label="Editar coluna">${icon('edit')}</button></div></header><div class="column-agent-list">${cards.map(modalCardHTML).join('')||`<div class="column-empty">${search?'Nenhum modal encontrado.':'Tudo começa com um propósito.<br>Crie um Modal de Agente nesta coluna.'}</div>`}</div><button class="create-agent" data-action="new-agent" data-id="${col.id}">${icon('plus')}Criar Modal de Agente</button></section>`;
  }).join('')}<button class="add-column-tile" data-action="new-column">${icon('plus')}Nova coluna</button></div>`;
  $$('.agent-card').forEach(card=>{
    card.addEventListener('dragstart',event=>{if(event.target.closest('button')){event.preventDefault();return;}event.dataTransfer.setData('text/plain',card.dataset.id);event.dataTransfer.effectAllowed='move';});
    card.addEventListener('dblclick',()=>openAgent(card.dataset.id));
  });
  $$('.column').forEach(col=>{
    col.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='move';col.classList.add('drop-target');});
    col.addEventListener('dragleave',event=>{if(!col.contains(event.relatedTarget))col.classList.remove('drop-target');});
    col.addEventListener('drop',async event=>{
      event.preventDefault();col.classList.remove('drop-target');const id=event.dataTransfer.getData('text/plain');
      const agent=state.modals.find(a=>a.id===id);if(!agent || agent.column_id===col.dataset.id)return;
      try{await api(`agent-modals/${id}/move`,'PUT',{column_id:col.dataset.id});await refresh();toast('Modal movido com todos os agentes.');}catch(e){toast(e.message,true);}
    });
  });
}
function agentStopHTML(agent){
  const reason=agent.stop_reason||(!agent.enabled?agent.runtime_error:'');
  if(!reason)return agent.enabled?'':'<p class="agent-stop-empty">Sem desligamento registrado. Os próximos desligamentos terão motivo e horário.</p>';
  const titles={completed:'Fila concluída',manual:'Desligado manualmente',edited:'Desligado após edição',uncertain:'Pausado · conferir envio',error:'Pausado por falha'};
  const date=agent.stopped_at?new Date(agent.stopped_at):null;
  const when=date&&Number.isFinite(date.getTime())?`<time datetime="${esc(agent.stopped_at)}">${esc(date.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'}))}</time>`:'';
  const body=`<strong>${esc(titles[agent.stop_code]||'Motivo do desligamento')}</strong>${when}<p>${esc(reason)}</p>`;
  return agent.enabled?`<details class="agent-last-stop"><summary>Último desligamento</summary><div class="agent-stop-info">${body}</div></details>`:`<div class="agent-stop-info ${agent.stop_code==='completed'?'stop-completed':''}" role="status">${body}</div>`;
}
function modalCardHTML(modal){
  const agents=modalAgents(modal.id), active=agents.filter(a=>a.enabled).length;
  return `<article class="agent-card modal-card" draggable="true" data-id="${modal.id}"><div class="card-heading"><div class="agent-avatar">${icon('spark')}</div><div class="modal-card-title"><span class="card-eyebrow">MODAL DE AGENTE</span><h3><button type="button" class="stage-fold modal-title-fold" data-action="fold-modal" data-id="${modal.id}" aria-expanded="${!isStageCollapsed(modal.id,'modal-card')}" aria-controls="modal-content-${modal.id}"><span>${esc(modal.name)}</span></button></h3></div><button type="button" class="icon-btn modal-chat-button" data-action="modal-chat" data-id="${modal.id}" aria-label="Conversar com o modal ${esc(modal.name)}" title="IA do modal">${icon('spark')}</button><button class="icon-btn" data-action="edit-agent" data-id="${modal.id}" aria-label="Editar modal ${esc(modal.name)}" title="Editar modal">${icon('edit')}</button></div><div class="modal-card-content" id="modal-content-${modal.id}" ${isStageCollapsed(modal.id,'modal-card')?'hidden':''}><p class="card-description">${esc(modal.description||'Uma base de conhecimento, vários objetivos.')}</p><div class="workflow-card-summary"><span>${agents.length} agente${agents.length===1?'':'s'}</span><span>${active} ativo${active===1?'':'s'} · base compartilhada</span></div><ol class="workflow-card-stages">${agents.map((a,i)=>{
    const labels={reviewing:'Reavaliando orientações',working:'Em atendimento',waiting_reply:'Aguardando resposta',waiting_tags:'Confirmando etiquetas',retrying:'Ligado · tentando novamente',waiting_upstream:'Aguardando etapa anterior',attention:'Ligado · conferir atendimentos'};
    const label=a.enabled?(labels[a.runtime_status]||'Aguardando contatos'):a.runtime_status==='completed'?'Fila concluída':a.runtime_status==='error'?'Pausado · conferir':'Desligado';
    const retryDate=a.retry_at?new Date(a.retry_at*1000):null;
    const retryText=retryDate?`<span class="retry-next">Próxima tentativa: ${esc(retryDate.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}))}</span>`:'';
    return `<li data-stage-id="${a.id}"><div class="workflow-stage-title"><span class="step">${i+1}</span><button type="button" class="stage-fold" data-action="fold-stage" data-id="${a.id}" aria-expanded="${!isStageCollapsed(a.id)}" aria-controls="stage-info-${a.id}"><strong>${esc(a.name)}</strong></button><button type="button" class="btn secondary agent-chat-button" data-action="agent-chat" data-id="${a.id}" title="Conversar com este agente" aria-label="Conversar com ${esc(a.name)}">${icon('spark')} IA</button><button class="toggle" role="switch" aria-checked="${Boolean(a.enabled)}" aria-label="${a.enabled?'Desligar':'Ativar'} ${esc(a.name)}" data-action="toggle" data-id="${a.id}"></button></div><div class="workflow-stage-body" id="stage-info-${a.id}" ${isStageCollapsed(a.id)?'hidden':''}><button type="button" class="btn secondary contacts-button" data-action="contact-list" data-id="${a.id}">Lista de Contatos <span>${a.contacts_count||0}</span></button><div class="workflow-tags">${esc(a.target_tag||'Sem entrada')} <span aria-label="para">→</span> ${esc(a.exit_routes?.map(route=>route.tag).join(' / ')||a.exit_tag||'Sem saída')}</div><span class="agent-status ${a.enabled?'active-status':a.runtime_status==='error'?'pending':''}"><span class="status-dot"></span>${label}</span>${a.enabled&&a.runtime_error?`<p class="agent-error">${esc(a.runtime_error)}${retryText}</p>`:''}${agentStopHTML(a)}</div></li>`;
  }).join('')}</ol></div></article>`;
}
function renderWhatsapps(){
  const ai=state.brain||{};
  $('#brain-model').textContent=ai.model||'gpt-5.4-mini';
  $('#brain-status').textContent=ai.verified?'Conectada':ai.configured?'Verificar conexão':'Não configurada';
  $('#brain-status').classList.toggle('connected-chip',Boolean(ai.verified));
  $('#brain-message').textContent=ai.message||(ai.verified?'Cérebro padrão dos agentes. Chave protegida no servidor.':'A configuração é feita pelo servidor.');
  $('#whatsapp-list').innerHTML=state.whatsapps.length?state.whatsapps.map(w=>{
    const status=w.connected?'Conectado':w.connection_status==='disconnected'?'WhatsApp desconectado':w.configured?'Verificação necessária':'Conexão pendente';
    return `<div class="whatsapp-row"><span class="whatsapp-icon">${icon('chat')}</span><div class="whatsapp-detail"><strong>${esc(w.name)}</strong><small>${esc(w.endpoint||'Endereço MCP ainda não informado')}</small>${w.configured?`<small class="connection-detail">${w.connected?(w.labels_supported===false?'MCP autorizado · alteração de etiquetas indisponível nesta conta':'MCP autorizado · seleção disponível'):esc(w.message||'Verifique a conexão.')}</small>`:''}</div><span class="pending-chip ${w.connected?'connected-chip':''}">${status}</span>${w.configured?`<button class="btn secondary check-connection" data-action="reconnect-whatsapp" data-id="${w.id}" aria-label="Reconectar ${esc(w.name)} por QR Code">Reconectar / QR Code</button>`:''}${w.configured?`<button class="btn secondary check-connection" data-action="check-whatsapp" data-id="${w.id}" aria-label="Verificar conexão de ${esc(w.name)}">Verificar</button>`:''}<button class="icon-btn" data-action="edit-whatsapp" data-id="${w.id}" aria-label="Editar ${esc(w.name)}" title="Editar WhatsApp">${icon('edit')}</button></div>`;
  }).join(''):`<div class="whatsapp-empty">Nenhum WhatsApp cadastrado. Adicione quando quiser.</div>`;
}
function confirmAction(title,text,button='Confirmar',danger=false){
  return new Promise(resolve=>{
    $('#confirm-title').textContent=title;$('#confirm-text').textContent=text;$('#confirm-ok').textContent=button;
    $('#confirm-ok').className='btn '+(danger?'danger':'primary');const dialog=$('#confirmation');dialog.returnValue='';
    dialog.addEventListener('close',()=>resolve(dialog.returnValue==='ok'),{once:true});dialog.showModal();
  });
}
function openEditor({title,subtitle,body,submit='Salvar',small=false,deleteLabel='',note=''}){
  const dialog=$('#editor');dialog.classList.toggle('small',small);dialog.classList.remove('workflow-editor');
  $('#editor-content').innerHTML=`<form id="editor-form"><header class="modal-header"><div><span class="eyebrow">SEU ESPAÇO DE IA</span><h2>${esc(title)}</h2><p class="muted">${esc(subtitle)}</p></div><button type="button" class="icon-btn" data-action="close-editor" title="Fechar" aria-label="Fechar">${icon('close')}</button></header><div class="modal-body">${body}</div><p class="form-error modal-form-error" id="editor-error" role="alert"></p><footer class="modal-footer">${deleteLabel?`<button type="button" class="btn danger" id="delete-item">${icon('trash')}${esc(deleteLabel)}</button>`:`<span class="modal-footer-note">${icon('lock')}${esc(note)}</span>`}<div class="actions"><button type="button" class="btn secondary" data-action="close-editor">Cancelar</button><button type="submit" class="btn primary">${esc(submit)}</button></div></footer></form>`;
  editorSnapshot=JSON.stringify([...new FormData($('#editor-form'))]);
  if(!dialog.open)dialog.showModal();
}
async function closeEditor(){
  if(saving)return;
  const changed=editorSnapshot!==JSON.stringify([...new FormData($('#editor-form'))]);
  if(changed && !await confirmAction('Descartar alterações?','As alterações que você fez ainda não foram salvas.','Descartar',true))return;
  $('#editor').close();
}
function bindSave(callback,message){
  $('#editor-form').addEventListener('submit',async event=>{
    event.preventDefault();if(saving)return;saving=true;const button=$('button[type=submit]',$('#editor-form'));button.disabled=true;$('#editor-error').textContent='';
    try{await callback(Object.fromEntries(new FormData(event.currentTarget)));await refresh();$('#editor').close();toast(message);}catch(e){$('#editor-error').textContent=e.message;}finally{saving=false;button.disabled=false;}
  });
}
function bindDelete(path,title,text,message){
  $('#delete-item')?.addEventListener('click',async event=>{
    if(saving)return;
    const button=event.currentTarget;
    if(!await confirmAction(title,text,'Excluir',true))return;
    button.disabled=true;saving=true;
    try{await api(path,'DELETE');await refresh();$('#editor').close();toast(message);}catch(e){$('#editor-error').textContent=e.message;}finally{saving=false;button.disabled=false;}
  });
}
function openColumn(id){
  const col=state.columns.find(c=>c.id===id);
  openEditor({title:col?'Editar coluna':'Nova coluna',subtitle:'Agrupe seus agentes por tipo, área ou propósito.',small:true,submit:col?'Salvar alterações':'Criar coluna',deleteLabel:col?'Excluir':'',body:`<label>Nome da coluna<input name="name" required maxlength="80" placeholder="Como você quer organizar seus agentes?" value="${esc(col?.name||'')}"></label><div><label>Cor</label><div class="color-choices">${[['green','Verde'],['blue','Azul'],['purple','Lilás'],['orange','Areia'],['pink','Rosa']].map(([color,label])=>`<label class="color-choice" title="${label}"><input type="radio" name="color" value="${color}" aria-label="${label}" ${color===(col?.color||'green')?'checked':''}><span class="color-sample ${color}"></span></label>`).join('')}</div></div>`});
  bindSave(data=>api(col?`columns/${id}`:'columns',col?'PUT':'POST',{...data,board_id:activeBoard}),col?'Coluna atualizada.':'Coluna criada. Agora você pode adicionar agentes.');
  if(col)bindDelete(`columns/${id}`,'Excluir coluna?',`A coluna “${col.name}” será excluída. Mova ou exclua os agentes dela antes.`, 'Coluna excluída.');
}
function openWhatsapp(id){
  const w=state.whatsapps.find(item=>item.id===id);
  openEditor({title:w?'Editar WhatsApp':'Adicionar WhatsApp',subtitle:w?.configured?'Instância MCP autorizada para esta plataforma.':'Uma referência para vincular aos seus agentes.',small:true,submit:w?'Salvar alterações':'Adicionar WhatsApp',deleteLabel:w&&!w.configured?'Excluir':'',body:`<label>Nome do WhatsApp *<input name="name" required maxlength="100" placeholder="Ex.: WhatsApp da equipe" value="${esc(w?.name||'')}"></label><label>Endereço do MCP <span class="label-optional">${w?.configured?'conectado':'opcional'}</span><input name="endpoint" type="url" maxlength="300" ${w?.configured?'readonly':''} placeholder="https://mcp.example.org" value="${esc(w?.endpoint||'')}"><span class="field-help">${w?.configured?'Endereço vinculado à autorização da instância.':'Apenas o endereço, sem senhas ou tokens.'}</span></label><div class="info-box">${icon('chat')}<p>${w?.configured?'A autorização desta instância fica protegida no servidor. Você pode selecioná-la nos agentes e ativar quando quiser.':'Este cadastro prepara uma referência. Para usar outra instância, configure a autorização MCP separadamente.'}</p></div>`});
  bindSave(data=>api(w?`whatsapps/${id}`:'whatsapps',w?'PUT':'POST',data),w?'WhatsApp atualizado.':'WhatsApp cadastrado. Conexão pendente.');
  if(w&&!w.configured)bindDelete(`whatsapps/${id}`,'Excluir referência de WhatsApp?',`A referência “${w.name}” será removida desta plataforma. Remova os vínculos nos agentes antes.`, 'Referência excluída.');
}
function openPassword(){
  openEditor({title:'Alterar senha',subtitle:'Atualize a senha de acesso ao seu espaço.',small:true,submit:'Atualizar senha',body:`<label>Senha atual<input name="current_password" type="password" autocomplete="current-password" required maxlength="128"></label><label>Nova senha<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><span class="field-help">Use pelo menos 12 caracteres.</span></label><label>Confirme a nova senha<input name="confirmation" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>`});
  bindSave(data=>{if(data.password!==data.confirmation)throw new Error('As novas senhas não coincidem.');return api('password','POST',data);},'Senha atualizada.');
}
async function toggleAgent(id,button){
  const a=state.agents.find(item=>item.id===id);if(!a)return;
  if(!a.enabled){
    if(!a.instructions||!a.objective||!a.target_tag||!a.exit_tag||!a.whatsapp_id){toast('Preencha as instruções, o objetivo, as duas tags e o WhatsApp antes de ativar.',true);openAgent(id);return;}
    if(!await confirmAction('Ativar agente?',`“${a.name}” atenderá os contatos da tag “${a.target_tag}” pelo WhatsApp escolhido. Ao concluir cada contato, aplicará “${a.exit_tag}” e retirará a entrada. Continuará ligado até finalizar todos os atendimentos, confirmar as etiquetas e não haver etapas anteriores ligadas que possam encaminhar contatos. O motivo do desligamento aparecerá no cartão. Você pode desligar quando quiser.`,'Ativar agente'))return;
  }
  button.disabled=true;
  try{await api(`agents/${id}/enabled`,'PUT',{enabled:!a.enabled});await refresh();toast(a.enabled?'Agente desligado.':'Agente ativo. Atenderá os contatos com a tag de entrada.');}catch(e){toast(e.message,true);}finally{button.disabled=false;}
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button)return;
  const {action,id}=button.dataset;
  if(action==='new-board')openBoard();
  if(action==='new-column')openColumn();
  if(action==='edit-column')openColumn(id);
  if(action==='new-agent')openAgent(null,id);
  if(action==='edit-agent')openAgent(id);
  if(action==='contact-list'){const agent=state.agents.find(a=>a.id===id);if(agent)await openContactList({agentId:id,name:agent.name});}
  if(action==='edit-whatsapp')openWhatsapp(id);
  if(action==='reconnect-whatsapp')openWhatsAppSession(id);
  if(action==='check-whatsapp'){
    button.disabled=true;button.textContent='Verificando…';
    try{const result=await api(`whatsapps/${id}/check`,'POST',{});await refresh();toast(result.message||'Conexão verificada.',!result.connected);}catch(e){toast(e.message,true);}finally{button.disabled=false;button.textContent='Verificar';}
  }
  if(action==='close-editor')await closeEditor();
  if(action==='agent-chat')await openAgentChat(id);
  if(action==='modal-chat')await openModalChat(id);
  if(action==='fold-modal')foldStage(button,id,'modal-card',button.closest('.modal-card').querySelector('.modal-card-content'));
  if(action==='fold-stage')foldStage(button,id,'card',button.closest('li').querySelector('.workflow-stage-body'));
  if(action==='toggle')await toggleAgent(id,button);
  if(action==='column-left'){
    const ids=boardColumns().map(c=>c.id);const i=ids.indexOf(id);if(i<1)return;
    [ids[i-1],ids[i]]=[ids[i],ids[i-1]];button.disabled=true;
    try{await api('columns-order','PUT',{ids,board_id:activeBoard});await refresh();}catch(e){toast(e.message,true);}finally{button.disabled=false;}
  }
});
$('#editor').addEventListener('cancel',event=>{event.preventDefault();closeEditor();});
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>changeView(button.dataset.view)));
$('#new-column').addEventListener('click',()=>openColumn());
$('#new-board').addEventListener('click',()=>openBoard());
$('#edit-board').addEventListener('click',()=>openBoard(activeBoard));
$('#board-select').addEventListener('change',event=>{activeBoard=event.target.value;localStorage.setItem('active-board',activeBoard);search='';$('#search').value='';renderBoards();renderBoard();});
$('#new-whatsapp').addEventListener('click',()=>openWhatsapp());
$('#change-password').addEventListener('click',openPassword);
$('#check-brain').addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;button.textContent='Verificando…';
  try{const result=await api('brain/check','POST',{});await refresh();toast(result.message||'Verificação concluída.',!result.verified);}catch(e){toast(e.message,true);}finally{button.disabled=false;button.textContent='Verificar';}
});
$('#search').addEventListener('input',event=>{search=event.target.value;renderBoard();});
$('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();const form=event.currentTarget;const button=$('button',form);button.disabled=true;$('#login-error').textContent='';
  try{await api('login','POST',Object.fromEntries(new FormData(form)));form.elements.password.value='';await showWorkspace();}catch(e){$('#login-error').textContent=e.message;}finally{button.disabled=false;}
});
[$('#logout'),$('#mobile-logout')].forEach(button=>button.addEventListener('click',async()=>{try{await api('logout','POST');await api('session');showLogin();}catch(e){toast(e.message,true);}}));
(async()=>{try{const result=await api('session');if(result.authenticated)await showWorkspace();else showLogin();}catch(e){showLogin();$('#login-error').textContent='Não foi possível carregar. Atualize a página para tentar novamente.';}})();
setInterval(()=>{if(!$('#workspace').hidden&&!$('#editor').open&&!document.hidden)refresh().catch(()=>{});},15000);

function syncInstallButton(){
  const installed=window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  $('#install-app').hidden=installed;
  $('#confirm-install').hidden=!installPrompt;
}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;syncInstallButton();});
window.addEventListener('appinstalled',()=>{installPrompt=null;syncInstallButton();$('#install-dialog').close();toast('App instalado. Abra pelo ícone na tela inicial.');});
$('#install-app').addEventListener('click',()=>{
  const ios=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const android=/Android/.test(navigator.userAgent);
  $('#install-ios').hidden=android;$('#install-android').hidden=ios;
  $('#install-message').textContent='';syncInstallButton();$('#install-dialog').showModal();
});
$('#close-install').addEventListener('click',()=>$('#install-dialog').close());
$('#confirm-install').addEventListener('click',async()=>{
  if(!installPrompt)return;
  const prompt=installPrompt;installPrompt=null;syncInstallButton();
  try{await prompt.prompt();const result=await prompt.userChoice;if(result.outcome==='accepted')$('#install-dialog').close();}
  catch{ $('#install-message').textContent='Use o menu do navegador para instalar o app.'; }
});
syncInstallButton();
if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});

let pairingId=null,pairingTimer=null,pairingGeneration=0,pairingBusy=false;
function clearPairingQR(){
  $('#pairing-qr').removeAttribute('src');$('.pairing-image').hidden=true;
}
function stopPairing(){
  pairingGeneration++;pairingId=null;clearTimeout(pairingTimer);clearPairingQR();pairingBusy=false;
}
async function pollPairing(reconnect=false){
  if(!pairingId||!$('#whatsapp-session-dialog').open||pairingBusy)return;
  if(document.hidden&&!reconnect){pairingTimer=setTimeout(()=>pollPairing(),3000);return;}
  const id=pairingId,generation=pairingGeneration;pairingBusy=true;
  const retry=$('#retry-pairing');retry.disabled=true;clearTimeout(pairingTimer);
  let connected=false;
  try{
    const result=await api(`whatsapps/${id}/${reconnect?'reconnect':'session'}`,reconnect?'POST':'GET',reconnect?{}:undefined);
    if(generation!==pairingGeneration||!$('#whatsapp-session-dialog').open)return;
    $('#pairing-name').textContent=result.name;$('#pairing-message').textContent=result.message;
    clearPairingQR();
    if(result.qr_image){$('#pairing-qr').src=result.qr_image;$('.pairing-image').hidden=false;}
    connected=result.connected;retry.hidden=connected;
    retry.textContent=result.qr_image?'Atualizar QR Code':'Gerar QR Code';
    if(connected){await refresh();toast('WhatsApp conectado. Nenhum agente foi ativado automaticamente.');}
  }catch(error){
    if(generation!==pairingGeneration)return;
    clearPairingQR();$('#pairing-message').textContent=error.message+' O painel tentará consultar novamente.';
  }finally{
    if(generation===pairingGeneration){
      pairingBusy=false;retry.disabled=false;
      if(!connected&&$('#whatsapp-session-dialog').open)pairingTimer=setTimeout(()=>pollPairing(),3000);
    }
  }
}
function openWhatsAppSession(id){
  stopPairing();pairingId=id;
  $('#pairing-name').textContent=state.whatsapps.find(w=>w.id===id)?.name||'WhatsApp';
  $('#pairing-message').textContent='Preparando a conexão. Aguarde o QR Code aparecer.';
  $('#retry-pairing').hidden=false;
  $('#whatsapp-session-dialog').showModal();pollPairing(true);
}
$('#retry-pairing').addEventListener('click',()=>pollPairing(true));
$('#close-pairing').addEventListener('click',()=>$('#whatsapp-session-dialog').close());
$('#whatsapp-session-dialog').addEventListener('close',stopPairing);
