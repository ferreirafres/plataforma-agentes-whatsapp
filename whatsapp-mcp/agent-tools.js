// Shared by every WhatsApp MCP instance. Read tools never call sendSeen.
import fs from 'node:fs';
import path from 'node:path';
import { OAUTH_DATA_DIR } from './data-paths.js';
import crypto from 'node:crypto';
import { z } from 'zod';

const normalized = value => String(value).trim().normalize('NFC').toLocaleLowerCase('pt-BR');
export function resolveLabel(labels, name) {
  const matches=labels.filter(label=>normalized(label.name)===normalized(name));
  if(matches.length!==1) throw new Error(matches.length?'Há etiquetas com nomes repetidos. Use um nome único.':`A etiqueta “${name}” não existe neste WhatsApp. Crie-a no WhatsApp Business.`);
  return matches[0];
}
export function handoffLabels(current,entry,exit) {
  if(String(entry)===String(exit)) throw new Error('As etiquetas de entrada e saída precisam ser diferentes.');
  return [...new Set(current.map(String).filter(id=>id!==String(entry)).concat(String(exit)))];
}

export function registerAgentTools(server,{client,requireScope,requireReady,requireFeature,auditLog,fetchChatHistory,formatMessage}) {
  const ok=data=>({content:[{type:'text',text:JSON.stringify(data)}]});
  const fail=message=>({isError:true,content:[{type:'text',text:JSON.stringify({success:false,message})}]});
  const wrap=(scope,fn)=>async(args,extra)=>{
    const featureError=requireFeature('FEATURE_AGENT_TAGS');if(featureError)return featureError;
    const denied=requireScope(extra,scope);if(denied)return denied;
    try{requireReady();return ok(await fn(args,extra));}catch(error){return fail(typeof error==='string'?error:error.message);}
  };
  async function labels() {
    return client.pupPage.evaluate(()=>{
      const platform=window.require('WAWebConnModel').Conn.platform;
      const supported=['smba','smbi'].includes(platform);
      const models=window.require('WAWebCollections').Label?.getModelsArray?.()||[];
      return {supported,labels:models.map(label=>({id:String(label.id),name:label.name||''}))};
    });
  }
  async function chatLabels(chatId) {
    return client.pupPage.evaluate(id=>{
      const chat=window.require('WAWebCollections').Chat.get(id);
      if(!chat)throw new Error('Conversa não encontrada nesta instância.');
      return (chat.labels||[]).map(String);
    },chatId);
  }
  async function scopeLabels(entryTag,exitTag,exitTags,{optionalExit=false}={}) {
    const result=await labels();
    if(!result.supported)throw new Error('Esta conta não disponibiliza etiquetas do WhatsApp Business.');
    if(!exitTag&&!optionalExit)throw new Error('Informe a etiqueta de saída.');
    const names=exitTags?.length?exitTags:exitTag?[exitTag]:[];
    if(exitTag&&!names.some(name=>normalized(name)===normalized(exitTag)))throw new Error('A saída selecionada não pertence às saídas cadastradas.');
    const entry=resolveLabel(result.labels,entryTag),exits=names.map(name=>resolveLabel(result.labels,name));
    if(exits.some(label=>label.id===entry.id))throw new Error('As etiquetas de entrada e saída precisam ser diferentes.');
    return {entry,exit:exitTag?resolveLabel(result.labels,exitTag):null,exits};
  }
  const scopeSchema={entry_tag:z.string().min(1).max(150),exit_tag:z.string().min(1).max(150),exit_tags:z.array(z.string().min(1).max(150)).min(1).max(50).optional()};
  const idSchema=z.string().regex(/@(c\.us|lid)$/).describe('ID real de conversa individual retornado pelo MCP.');
  server.registerTool('list_contact_labels',{
    title:'Listar etiquetas do WhatsApp Business',description:'READ-ONLY: lista etiquetas reais e informa se a conta suporta etiquetas. Não lê mensagens nem marca conversas como lidas.',inputSchema:{}
  },wrap('whatsapp:read',async()=>({success:true,...await labels()})));
  server.registerTool('get_chats_by_entry_tag',{
    title:'Listar contatos por etiqueta de entrada',description:'READ-ONLY: retorna conversas individuais com a etiqueta de entrada. Para buscar apenas uma etiqueta, informe só entry_tag. Informe exit_tag ou exit_tags somente se quiser excluir etiquetas existentes. Use nomes únicos e exatos.',
    inputSchema:{...scopeSchema,exit_tag:scopeSchema.exit_tag.optional()}
  },wrap('whatsapp:read',async({entry_tag,exit_tag,exit_tags})=>{
    const {entry,exit,exits}=await scopeLabels(entry_tag,exit_tag,exit_tags,{optionalExit:true});
    const chats=await client.pupPage.evaluate(({entry,exits})=>window.require('WAWebCollections').Chat.getModelsArray().filter(chat=>{
      const id=chat.id?._serialized||'';const tags=(chat.labels||[]).map(String);
      return /@(c\.us|lid)$/.test(id)&&tags.includes(entry)&&!exits.some(id=>tags.includes(id));
    }).map(chat=>({chat_id:chat.id._serialized,name:chat.formattedTitle||chat.name||'',is_group:false})),{entry:entry.id,exits:exits.map(label=>label.id)});
    return {success:true,chats,entry_label_id:entry.id,exit_label_id:exit?.id??null};
  }));
  server.registerTool('get_agent_chat_state',{
    title:'Consultar estado de conversa do agente',description:'READ-ONLY: confirma as etiquetas e retorna até 40 mensagens de uma conversa individual dentro do escopo.',
    inputSchema:{chat_id:idSchema,...scopeSchema}
  },wrap('whatsapp:read',async({chat_id,entry_tag,exit_tag,exit_tags})=>{
    const {entry,exits}=await scopeLabels(entry_tag,exit_tag,exit_tags);const current=await chatLabels(chat_id);
    const eligible=current.includes(entry.id)&&!exits.some(label=>current.includes(label.id));
    if(!eligible)return {success:true,eligible:false,messages:[]};
    const history=await fetchChatHistory(chat_id,{targetCount:40});
    if(history.error)throw new Error('Não foi possível ler o histórico deste contato.');
    return {success:true,eligible:true,messages:history.messages.map(formatMessage)};
  }));

  server.registerTool('enqueue_agent_contact',{
    title:'Incluir número na entrada de um agente',description:'WRITE: valida um número individual, prepara sua conversa e adiciona a etiqueta de entrada, preservando outras etiquetas. Não envia mensagem e não reinscreve contatos já finalizados.',
    inputSchema:{phone:z.string().regex(/^[1-9]\d{9,14}$/),...scopeSchema}
  },wrap('whatsapp:labels',async({phone,entry_tag,exit_tag,exit_tags},extra)=>{
    const {entry,exits}=await scopeLabels(entry_tag,exit_tag,exit_tags);
    const number=await client.getNumberId(phone);
    if(!number)return {success:true,valid:false,message:'Este número não foi encontrado no WhatsApp. Confira o DDI e o DDD.'};
    // getChatById serializes the entire chat, including its last message.
    // Some WhatsApp Web models throw a minified error during serialization.
    // Enrollment only needs the raw individual chat's identity and labels.
    const chat=await client.pupPage.evaluate(async id=>{
      const raw=await window.WWebJS.getChat(id,{getAsModel:false});
      return raw?{id:{_serialized:raw.id?._serialized},isGroup:!!raw.groupMetadata}:null;
    },number._serialized);
    const chat_id=chat?.id?._serialized;
    if(!chat_id||!/@(c\.us|lid)$/.test(chat_id)||chat.isGroup)throw new Error('Não foi possível preparar uma conversa individual para este número.');
    const current=await chatLabels(chat_id);
    if(exits.some(label=>current.includes(label.id)))return {success:true,valid:true,already_completed:true,chat_id};
    if(!current.includes(entry.id))await client.addOrRemoveLabels([...new Set([...current,entry.id])],[chat_id]);
    const verified=await chatLabels(chat_id);
    if(!verified.includes(entry.id))throw new Error('O WhatsApp não confirmou a etiqueta de entrada do contato da lista.');
    auditLog({action:'enqueue_agent_contact',ok:true,identityId:extra.authInfo.extra.identityId});
    return {success:true,valid:true,queued:true,chat_id};
  }));

  // Persist before sending. An interrupted, uncertain send is never retried automatically.
  const operationsPath=path.join(OAUTH_DATA_DIR, 'agent-operations.json');
  let operationQueue=Promise.resolve();
  const serial=fn=>{const promise=operationQueue.then(fn,fn);operationQueue=promise.catch(()=>{});return promise;};
  async function once(requestId,identityId,fingerprint,fn) {
    return serial(async()=>{
      const operations=fs.existsSync(operationsPath)?JSON.parse(fs.readFileSync(operationsPath,'utf8')):{};
      const key=identityId+':'+requestId;const previous=operations[key];
      if(previous){
        if(previous.fingerprint!==fingerprint)throw new Error('Chave de operação já utilizada para outro conteúdo.');
        if(previous.status==='completed')return previous.result;
        throw new Error('Envio anterior com resultado incerto. Confira a conversa antes de retomar.');
      }
      const save=()=>{const temporary=operationsPath+'.tmp';fs.writeFileSync(temporary,JSON.stringify(operations),{mode:0o600});fs.renameSync(temporary,operationsPath);};
      operations[key]={status:'started',fingerprint,created_at:new Date().toISOString()};save();
      const result=await fn();operations[key]={...operations[key],status:'completed',result};save();return result;
    });
  }
  server.registerTool('send_agent_reply',{
    title:'Responder contato no escopo de um agente',description:'WRITE: envia uma única mensagem apenas se as etiquetas ainda colocam o contato no escopo. Chave de idempotência obrigatória.',
    inputSchema:{chat_id:idSchema,...scopeSchema,body:z.string().min(1).max(6000),request_id:z.string().min(1).max(150)}
  },wrap('whatsapp:send',async(args,extra)=>{
    const {entry,exits}=await scopeLabels(args.entry_tag,args.exit_tag,args.exit_tags);const current=await chatLabels(args.chat_id);
    if(!current.includes(entry.id)||exits.some(label=>current.includes(label.id)))throw new Error('O contato já saiu do escopo. Nenhuma mensagem foi enviada.');
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
    return once(args.request_id,extra.authInfo.extra.identityId,fingerprint,async()=>{
      const sent=await client.sendMessage(args.chat_id,args.body);
      auditLog({action:'send_agent_reply',ok:true,identityId:extra.authInfo.extra.identityId,requestId:args.request_id});
      return {success:true,message_id:sent?.id?._serialized||null};
    });
  }));
  server.registerTool('handoff_agent_contact',{
    title:'Aplicar etiqueta de saída e encerrar atuação',description:'WRITE: preserva todas as outras etiquetas, adiciona a de saída e remove a de entrada. Idempotente. Não envia mensagens.',
    inputSchema:{chat_id:idSchema,...scopeSchema}
  },wrap('whatsapp:labels',async({chat_id,entry_tag,exit_tag,exit_tags},extra)=>{
    const {entry,exit,exits}=await scopeLabels(entry_tag,exit_tag,exit_tags);const current=await chatLabels(chat_id);
    if(!current.includes(entry.id)&&current.includes(exit.id))return {success:true,already_completed:true};
    if(!current.includes(entry.id))throw new Error('O contato já saiu do escopo.');
    if(exits.some(label=>current.includes(label.id)))throw new Error('O contato já possui uma saída. Confira a conversa antes de alterar sua conclusão.');
    await client.addOrRemoveLabels(handoffLabels(current,entry.id,exit.id),[chat_id]);
    const verified=await chatLabels(chat_id);
    if(verified.includes(entry.id)||!verified.includes(exit.id))throw new Error('O WhatsApp não confirmou a troca das etiquetas.');
    auditLog({action:'handoff_agent_contact',ok:true,identityId:extra.authInfo.extra.identityId});
    return {success:true,completed:true};
  }));
  server.registerTool('send_agent_handoff_summary',{
    title:'Comunicar handoff ao destino indicado pelo administrador',description:'WRITE: envia resumo a um grupo com nome exato e único ou ao número individual explícito do administrador. Informe exatamente um destino. Idempotência obrigatória.',
    inputSchema:{group_name:z.string().min(1).max(200).optional(),contact_phone:z.string().regex(/^[1-9]\d{9,14}$/).optional(),body:z.string().min(1).max(12000),request_id:z.string().min(1).max(150)}
  },wrap('whatsapp:send',async(args,extra)=>{
    if(!!args.group_name===!!args.contact_phone)throw new Error('Informe um único destino para o resumo.');
    let destination;
    if(args.contact_phone){
      const number=await client.getNumberId(args.contact_phone);
      if(!number)throw new Error('O contato de resumo não foi encontrado no WhatsApp. Confira o número nas instruções.');
      destination=await client.pupPage.evaluate(async id=>{
        const chat=await window.WWebJS.getChat(id,{getAsModel:false});
        return chat&&!chat.groupMetadata?chat.id?._serialized:null;
      },number._serialized);
      if(!destination||!/@(c\.us|lid)$/.test(destination))throw new Error('Não foi possível preparar o contato individual de resumo.');
    }else{
      const chats=await client.pupPage.evaluate(name=>window.require('WAWebCollections').Chat.getModelsArray()
        .filter(chat=>chat.id?._serialized?.endsWith('@g.us')&&String(chat.formattedTitle||chat.name||'').trim().normalize('NFC').toLocaleLowerCase('pt-BR')===name)
        .map(chat=>chat.id._serialized),normalized(args.group_name));
      if(chats.length!==1)throw new Error('O grupo de handoff não foi encontrado de forma única. Confira o nome nas instruções.');
      destination=chats[0];
    }
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex');
    return once(args.request_id,extra.authInfo.extra.identityId,fingerprint,async()=>{
      await client.sendMessage(destination,args.body);
      auditLog({action:'send_agent_handoff_summary',ok:true,identityId:extra.authInfo.extra.identityId,requestId:args.request_id});
      return {success:true};
    });
  }));
}
