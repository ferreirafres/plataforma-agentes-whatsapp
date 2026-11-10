'use strict';

function openAgent(id,columnId){
  const selectedAgent=state.agents.find(a=>a.id===id);
  const modal=state.modals.find(m=>m.id===(selectedAgent?.modal_id||id));
  const account=currentBoard()?.whatsapp_id;
  const selectedColumn=modal?.column_id||columnId||boardColumns()[0]?.id;
  let draft=modal?modalAgents(modal.id).map(a=>({...a,entry_auto:Boolean(a.entry_auto),whatsapp_id:a.whatsapp_inherited?'':a.whatsapp_id||''})):[blankStage()];
  const options=(selected,inherit=false)=>`${inherit?'<option value="">Usar WhatsApp da base</option>':account?'':'<option value="">Selecionar depois</option>'}${state.whatsapps.filter(w=>!account||w.id===account).map(w=>`<option value="${esc(w.id)}" ${w.id===selected?'selected':''}>${esc(w.name)}${w.connected?' · conectado':''}</option>`).join('')}`;
  openEditor({title:modal?'Editar Modal de Agente':'Novo Modal de Agente',subtitle:'Uma base de conhecimento compartilhada. Cada agente, um objetivo no fluxo.',submit:modal?'Salvar alterações':'Criar modal',deleteLabel:modal?'Excluir modal':'',note:'Os agentes começam desligados.',body:`
    <details class="knowledge-section" open><summary><span class="step">01</span><span>Base de Conhecimento<small>Identidade e contexto comuns a todos os agentes</small></span><span class="knowledge-visibility"><span class="when-open">Ocultar</span><span class="when-closed">Mostrar</span></span></summary>
    <div class="knowledge-fields"><label>Nome do agente / modal *<input name="name" required maxlength="120" placeholder="Ex.: Atendimento comercial" value="${esc(modal?.name||'')}"></label>
    <label>Identidade do agente<textarea name="identity" maxlength="10000" rows="4" placeholder="Quem é o agente? Defina sua função, personalidade e tom de voz.">${esc(modal?.identity||'')}</textarea></label>
    <label class="full-field">Contexto do agente<textarea name="context" maxlength="50000" rows="6" placeholder="Informações para consulta: serviços, produtos, horários, perguntas frequentes e outros detalhes do atendimento.">${esc(modal?.context||'')}</textarea><span class="field-help">Todos os agentes consultam estas informações para responder às perguntas do contato. Até 50.000 caracteres.</span></label>
    <label>Descrição breve<textarea name="description" maxlength="300" rows="2" placeholder="Uma frase sobre este fluxo">${esc(modal?.description||'')}</textarea></label>
    <label>WhatsApp da base<select name="whatsapp_id">${options(account||modal?.whatsapp_id)}</select><span class="field-help">${account?'Conta vinculada ao quadro.':'Usado pelos agentes que herdarem o WhatsApp da base.'}</span></label></div></details>
    <section class="workflow-section"><div class="workflow-section-heading"><div><span class="step">02</span><h3>Agente <span class="count" id="workflow-count"></span></h3></div><button type="button" class="btn secondary" id="add-workflow-agent">${icon('plus')}Adicionar agente</button></div>
    <p class="field-help">Cada etapa herda a identidade e o contexto da base. Defina o que cada agente deve alcançar e conecte as etapas pelas tags.</p>
    <div class="workflow-preview" id="workflow-preview" aria-label="Sequência dos agentes"></div><div id="workflow-stages"></div>
    <div class="info-box">${icon('spark')}<p>Salve o modal e ligue cada agente pelo cartão. Ele continua ligado até finalizar todos os atendimentos da tag, confirmar a troca das etiquetas e não haver etapas anteriores ligadas que possam encaminhar contatos. O motivo e o horário do desligamento aparecem no cartão. Salvar alterações desliga os agentes para revisão. As tags devem existir no WhatsApp Business selecionado.</p></div></section>
    <label>Coluna do modal<select name="column_id" required>${boardColumns().map(c=>`<option value="${esc(c.id)}" ${c.id===selectedColumn?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label>`});
  $('#editor').classList.add('workflow-editor');
  if(modal){const chat=document.createElement('button');chat.type='button';chat.className='btn secondary';chat.dataset.action='modal-chat';chat.dataset.id=modal.id;chat.setAttribute('aria-label','Conversar com o modal '+modal.name);chat.innerHTML=icon('spark')+' IA do modal';$('.modal-header').insertBefore(chat,$('.modal-header [data-action=close-editor]'));}

  function blankStage(){return {name:'',objective:'',instructions:'',target_tag:'',exit_tag:'',whatsapp_id:'',entry_auto:true};}
  function collect(){
    return $$('.workflow-agent-editor').map((el,i)=>{
      const stage={...(draft[i]?.id?{id:draft[i].id}:{}),_foldKey:draft[i]?._foldKey||draft[i]?.id||('new-'+Math.random().toString(36).slice(2))};
      $$('[data-stage-field]',el).forEach(input=>{stage[input.dataset.stageField]=input.type==='checkbox'?input.checked:input.value;});
      stage.exit_routes=$$('.exit-route',el).map(row=>({tag:$('[data-route-tag]',row).value,condition:$('[data-route-condition]',row).value}));
      stage.exit_tag=stage.exit_routes[0]?.tag||'';
      stage.contact_changes=draft[i]?.contact_changes||{add:[],remove:[]};
      return stage;
    });
  }
  function sync(){
    const elements=$$('.workflow-agent-editor');
    elements.forEach((el,i)=>{
      const entry=$('[data-stage-field="target_tag"]',el), auto=$('[data-stage-field="entry_auto"]',el);
      entry.readOnly=Boolean(i&&auto?.checked);
      if(entry.readOnly)entry.value=$('[data-stage-field="exit_tag"]',elements[i-1]).value;
      const previous=i?$('[data-stage-field="exit_tag"]',elements[i-1]).value:'';
      $('.auto-entry-help',el).textContent=i?(auto.checked?`Entrada herdada da etapa anterior: ${previous||'defina a tag de saída anterior'}.`:'Entrada manual: informe a etiqueta que inicia esta etapa.'):'Esta tag inicia o fluxo de atendimento.';
      const baseId=$('[name="whatsapp_id"]',$('#editor-form')).value;
      const ownId=$('[data-stage-field="whatsapp_id"]',el).value;
      const whatsapp=state.whatsapps.find(w=>w.id===(ownId||baseId));
      $('.stage-account-help',el).textContent=`${ownId?'Conta própria':'Herdando da base'}: ${whatsapp?.name||'selecione um WhatsApp'}.`;
      $('.stage-title',el).textContent=$('[data-stage-field="name"]',el).value||`Agente ${i+1}`;
    });
    const stages=collect();
    $('#workflow-count').textContent=stages.length;
    $('#add-workflow-agent').disabled=stages.length>=50;
    $('#workflow-preview').innerHTML=stages.map((a,i)=>`<span class="preview-stage"><b>${i+1}</b>${esc(a.name||`Agente ${i+1}`)}<small>${esc(a.target_tag||'Entrada')} → ${esc(a.exit_routes.map(route=>route.tag).filter(Boolean).join(' / ')||'Saída')}</small></span>${i<stages.length-1?'<span class="preview-arrow" aria-hidden="true">→</span>':''}`).join('');
  }
  function render(){
    $('#workflow-stages').innerHTML=draft.map((a,i)=>{
      const input=(field,value,attrs='')=>`name="stage_${i}_${field}" data-stage-field="${field}" ${attrs} ${value===undefined?'':`value="${esc(value)}"`}`;
      const routes=a.exit_routes?.length?a.exit_routes:[{tag:a.exit_tag||'',condition:''}];
      const changes=a.contact_changes||{add:[],remove:[]};
      a._foldKey=a.id||a._foldKey||('draft-'+Math.random().toString(36).slice(2));
      const foldKey=a._foldKey,collapsed=isStageCollapsed(foldKey,'editor');
      return `<section class="workflow-agent-editor" data-fold-key="${esc(foldKey)}" data-index="${i}" aria-label="Etapa ${i+1}"><input type="hidden" name="stage_${i}_id" value="${esc(a.id||'new')}"><input type="hidden" name="stage_${i}_contacts" value="${esc(JSON.stringify(changes))}"><header class="workflow-agent-heading"><span class="step">${String(i+1).padStart(2,'0')}</span><h4><button type="button" class="stage-fold" data-stage-action="fold" aria-controls="editor-stage-info-${esc(foldKey)}" aria-expanded="${!collapsed}"><span class="stage-title">${esc(a.name||`Agente ${i+1}`)}</span></button></h4><button type="button" class="btn secondary contacts-button" data-stage-action="contacts">Lista de Contatos <span>${(a.contacts_count||0)+changes.add.length-changes.remove.length}</span></button><div class="workflow-stage-actions"><button type="button" class="icon-btn" data-stage-action="up" ${i===0?'disabled':''} aria-label="Mover agente ${i+1} para cima" title="Mover para cima">↑</button><button type="button" class="icon-btn" data-stage-action="down" ${i===draft.length-1?'disabled':''} aria-label="Mover agente ${i+1} para baixo" title="Mover para baixo">↓</button><button type="button" class="icon-btn" data-stage-action="remove" ${draft.length===1?'disabled':''} aria-label="Remover agente ${i+1}" title="Remover agente">${icon('trash')}</button></div></header>
      <div class="workflow-editor-stage-body" id="editor-stage-info-${esc(foldKey)}" ${collapsed?'hidden':''}><p class="inheritance-note">${icon('lock')}Identidade e contexto herdados da Base de Conhecimento</p><div class="stage-fields">
      <label>Nome do agente *<input ${input('name',a.name,'required maxlength="120"')} placeholder="Ex.: Qualificação inicial"></label>
      <label>WhatsApp<select ${input('whatsapp_id')}>${options(a.whatsapp_id,true)}</select><span class="field-help stage-account-help"></span></label>
      <label class="full-field">Objetivo<textarea ${input('objective',undefined,'maxlength="5000" rows="3"')} placeholder="Qual resultado esta etapa deve alcançar?">${esc(a.objective)}</textarea></label>
      <label class="full-field">Instruções do agente<textarea ${input('instructions',undefined,'maxlength="20000" rows="5"')} placeholder="Como este agente deve agir para alcançar seu objetivo?">${esc(a.instructions)}</textarea></label>
      <div class="tag-fields full-field"><label>Tag de entrada<input ${input('target_tag',a.target_tag,'maxlength="150"')} placeholder="Etiqueta que inicia esta etapa"><span class="field-help auto-entry-help"></span></label><div class="exit-routes"><div class="exit-routes-heading"><button type="button" class="icon-btn" data-exit-action="add" title="Adicionar tag de saída" aria-label="Adicionar tag de saída">${icon('plus')}</button><strong>Tags de saída</strong></div>${routes.map((route,r)=>`<div class="exit-route" data-route-index="${r}"><label>Tag de saída ${r+1}${r===0?' · principal':''}<input name="stage_${i}_route_${r}_tag" data-route-tag ${r===0?'data-stage-field="exit_tag"':''} value="${esc(route.tag)}" maxlength="150" placeholder="Etiqueta aplicada ao concluir"></label><label>Quando usar esta saída<textarea name="stage_${i}_route_${r}_condition" data-route-condition maxlength="2000" rows="2" placeholder="Ex.: Se houver interesse, encaminhar para proposta.">${esc(route.condition)}</textarea></label>${routes.length>1?`<button type="button" class="icon-btn remove-exit" data-exit-action="remove" aria-label="Remover saída ${r+1}" title="Remover saída">${icon('trash')}</button>`:''}</div>`).join('')}<p class="field-help">O agente escolhe uma saída conforme as condições e o objetivo. A entrada automática da próxima etapa usa a primeira saída; para outros caminhos, configure a entrada manualmente.</p></div></div>
      ${i?`<label class="auto-entry-option full-field"><input type="checkbox" name="stage_${i}_entry_auto" data-stage-field="entry_auto" ${a.entry_auto?'checked':''}>Usar automaticamente a tag de saída do agente anterior</label>`:''}</div></div></section>`;
    }).join('');
    sync();
  }
  render();
  // Snapshot after rendering dynamic fields, including checkbox state.
  editorSnapshot=JSON.stringify([...new FormData($('#editor-form'))]);
  $('#editor-form').addEventListener('input',sync);
  $('#editor-form').addEventListener('change',sync);
  $('#add-workflow-agent').addEventListener('click',()=>{
    draft=collect();if(draft.length>=50)return;draft.push(blankStage());render();
    const last=$$('.workflow-agent-editor').at(-1);$('[data-stage-field="name"]',last).focus();
  });
  $('#workflow-stages').addEventListener('click',async event=>{
    const exitButton=event.target.closest('[data-exit-action]');
    if(exitButton){
      const index=Number(exitButton.closest('[data-index]').dataset.index);draft=collect();
      if(exitButton.dataset.exitAction==='add'){if(draft[index].exit_routes.length>=50){toast('Use até 50 saídas por agente.',true);return;}draft[index].exit_routes.push({tag:'',condition:''});}
      else draft[index].exit_routes.splice(Number(exitButton.closest('[data-route-index]').dataset.routeIndex),1);
      draft[index].exit_tag=draft[index].exit_routes[0]?.tag||'';render();return;
    }
    const button=event.target.closest('[data-stage-action]');if(!button||saving)return;
    const index=Number(button.closest('[data-index]').dataset.index),action=button.dataset.stageAction;
    if(action==='fold'){const section=button.closest('.workflow-agent-editor');foldStage(button,section.dataset.foldKey,'editor',$('.workflow-editor-stage-body',section));return;}
    if(action==='contacts'){
      draft=collect();
      await openContactList({agentId:draft[index].id,name:draft[index].name,changes:draft[index].contact_changes,
        onSave:changes=>{draft=collect();draft[index].contact_changes=changes;render();}});return;
    }
    if(action==='remove'&&!await confirmAction('Remover agente do modal?','A etapa será removida ao salvar. As entradas automáticas serão recalculadas conforme a nova ordem.','Remover',true))return;
    draft=collect();
    if(action==='remove'){if(draft.length===1)return;draft.splice(index,1);}
    else{const destination=index+(action==='up'?-1:1);if(destination<0||destination>=draft.length)return;[draft[index],draft[destination]]=[draft[destination],draft[index]];}
    // The new first stage needs an explicit entry; other automatic links follow their predecessor.
    draft[0].entry_auto=false;render();
  });
  bindSave(data=>{
    const agents=collect();
    return api(modal?`agent-modals/${modal.id}`:'agent-modals',modal?'PUT':'POST',{
      name:data.name,identity:data.identity,context:data.context,description:data.description,
      whatsapp_id:data.whatsapp_id,column_id:data.column_id,agents,...(modal?{revision:modal.revision}:{})
    });
  },modal?'Modal atualizado. Agentes desligados para revisão.':'Modal criado. Ligue os agentes quando estiver pronto.');
  if(modal)bindDelete(`agent-modals/${modal.id}`,'Excluir Modal de Agente?',`A base de conhecimento e todos os ${draft.length} agentes de “${modal.name}” serão excluídos permanentemente.`,'Modal excluído.');
}
