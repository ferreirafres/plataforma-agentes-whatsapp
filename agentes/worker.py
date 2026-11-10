"""One polling worker. It does no contact work unless an agent is explicitly enabled."""
import json
import signal
import time
import uuid
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from app import DATA, brain, db, mcp
from mcp_client import ConnectionError, TemporaryConnectionError
from openai_brain import BrainError, TemporaryBrainError
from runtime_lock import action_lock
from agent_features import output_routes,scope_args
from agent_chat import guidance_key


class ScopeChanged(Exception):
    pass


class HandoffPending(Exception):
    """Only the contact's label confirmation is pending; other contacts can proceed."""
    pass


class SummaryPending(HandoffPending):
    """The named group was not resolved, so no summary send was attempted."""
    pass

class ContactRemoved(Exception):
    pass


class AgentWorker:
    def __init__(self):
        self.cursors={}
        self.job_cursors={}
    def heartbeat(self):
        with db() as conn:
            conn.execute("INSERT INTO settings VALUES ('worker_heartbeat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(str(time.time()),))

    def current(self,agent):
        with db() as conn:
            current=conn.execute('SELECT * FROM agents WHERE id=?',(agent['id'],)).fetchone()
        return bool(current and current['enabled'] and current['revision']==agent['revision'])

    def status(self,agent,status,error=''):
        with db() as conn:
            conn.execute('UPDATE agents SET runtime_status=?,runtime_error=? WHERE id=? AND enabled=1 AND revision=?',
                         (status,error[:500],agent['id'],agent['revision']))

    def pause(self,agent,message):
        with action_lock(DATA),db() as conn:
            uncertain=conn.execute("SELECT 1 FROM agent_jobs WHERE agent_id=? AND stage='uncertain'",(agent['id'],)).fetchone()
            if uncertain:
                message='Envio com resultado incerto. '+message+' Confira a conversa antes de retomar; a mensagem não será repetida automaticamente.'
            conn.execute("""UPDATE agents SET enabled=0,revision=revision+1,runtime_status='error',runtime_error=?,
                stop_code=?,stop_reason=?,stopped_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),retry_at=0,retry_count=0,
                updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND revision=? AND enabled=1""",
                         (message[:500],'uncertain' if uncertain else 'error',message[:1000],agent['id'],agent['revision']))
        print('Agente pausado devido a uma falha de operação.',flush=True)

    def retry_later(self,agent,message):
        with action_lock(DATA),db() as conn:
            if not self.current(agent):raise ScopeChanged()
            uncertain=conn.execute("SELECT 1 FROM agent_jobs WHERE agent_id=? AND stage='uncertain'",(agent['id'],)).fetchone()
            if not uncertain:
                attempts=conn.execute('SELECT retry_count FROM agents WHERE id=?',(agent['id'],)).fetchone()[0]+1
                delay=min(20 * 2 ** min(attempts-1,4),300)
                conn.execute("""UPDATE agents SET runtime_status='retrying',runtime_error=?,retry_count=?,retry_at=?
                    WHERE id=? AND revision=? AND enabled=1""",(message[:500],attempts,time.time()+delay,agent['id'],agent['revision']))
        if uncertain:self.pause(agent,message)

    def active_producer(self,conn,agent):
        return any(route['tag'].strip().casefold()==agent['target_tag'].strip().casefold()
            for row in conn.execute('SELECT exit_tag,exit_routes FROM agents WHERE enabled=1 AND whatsapp_id=? AND id!=?',
                                    (agent['whatsapp_id'],agent['id']))
            for route in output_routes(dict(row)))

    def checked_action(self,agent,key,name,args,job_id=None,contact_id=None):
        self.heartbeat()
        with action_lock(DATA):
            if not self.current(agent): raise ScopeChanged()
            if contact_id:
                with db() as conn:
                    if not conn.execute("SELECT 1 FROM agent_contacts WHERE id=? AND agent_id=? AND status='pending'",(contact_id,agent['id'])).fetchone():raise ContactRemoved()
            is_send=name in ('send_agent_reply','send_agent_handoff_summary')
            # Persist uncertainty before a send. A process crash or HTTP timeout
            # cannot trigger an automatic duplicate on restart.
            if is_send:
                with db() as conn: conn.execute("UPDATE agent_jobs SET stage='uncertain' WHERE id=?",(job_id,))
            return mcp.call_tool(key,name,args)

    def enroll_contacts(self,agent,key):
        with db() as conn:
            contacts=[dict(row) for row in conn.execute("SELECT * FROM agent_contacts WHERE agent_id=? AND status='pending' AND retry_at<=? ORDER BY attempts,rowid LIMIT 5",(agent['id'],time.time()))]
        for contact in contacts:
            try:result=self.checked_action(agent,key,'enqueue_agent_contact',scope_args(agent)|{'phone':contact['phone']},contact_id=contact['id'])
            except ContactRemoved:continue
            except ConnectionError as error:
                if 'não confirmou a etiqueta de entrada' not in str(error):raise
                with db() as conn:
                    conn.execute('UPDATE agent_contacts SET error=?,attempts=attempts+1,retry_at=? WHERE id=? AND agent_id=?',
                        ('Aguardando confirmação da tag de entrada. Nova tentativa automática.',time.time()+min(20*2**min(contact['attempts'],4),300),contact['id'],agent['id']))
                continue
            if not self.current(agent):raise ScopeChanged()
            status='completed' if result.get('already_completed') else 'error' if result.get('valid') is False else 'queued'
            chat_id=result.get('chat_id')
            if status=='queued' and (not isinstance(chat_id,str) or not chat_id.endswith(('@c.us','@lid'))):
                raise ConnectionError('O WhatsApp não confirmou a inclusão do contato na tag de entrada.')
            with action_lock(DATA),db() as conn:
                if not self.current(agent):raise ScopeChanged()
                conn.execute('UPDATE agent_contacts SET status=?,chat_id=?,error=?,attempts=attempts+1,retry_at=0 WHERE id=? AND agent_id=?',
                    (status,chat_id,str(result.get('message',''))[:500] if status=='error' else '',contact['id'],agent['id']))
                if status=='queued':conn.execute('INSERT OR IGNORE INTO agent_sessions (agent_id,chat_id) VALUES (?,?)',(agent['id'],chat_id))

    def update_job(self,job_id,stage):
        with db() as conn: conn.execute('UPDATE agent_jobs SET stage=? WHERE id=?',(stage,job_id))

    def track_contacts(self,agent,chats):
        # Track the entire eligible list, including contacts outside this cycle's batch.
        # A removed entry label alone is not proof that the objective was completed.
        with action_lock(DATA),db() as conn:
            if not self.current(agent):raise ScopeChanged()
            conn.executemany("""INSERT INTO agent_sessions (agent_id,chat_id) VALUES (?,?)
                ON CONFLICT(agent_id,chat_id) DO UPDATE SET started=0,last_incoming='',completed=0,summary=''
                WHERE agent_sessions.completed=1""",[(agent['id'],chat['chat_id']) for chat in chats])

    def finish_if_complete(self,agent,chats):
        if chats:return False
        with action_lock(DATA),db() as conn:
            if not self.current(agent):raise ScopeChanged()
            count,unfinished=conn.execute('SELECT COUNT(*),COALESCE(SUM(completed=0),0) FROM agent_sessions WHERE agent_id=?',(agent['id'],)).fetchone()
            pending=conn.execute("SELECT 1 FROM agent_jobs WHERE agent_id=? AND stage!='done'",(agent['id'],)).fetchone()
            listed=conn.execute("SELECT 1 FROM agent_contacts WHERE agent_id=? AND status IN ('pending','error')",(agent['id'],)).fetchone()
            if not count:count=conn.execute("SELECT COUNT(*) FROM agent_contacts WHERE agent_id=? AND status='completed'",(agent['id'],)).fetchone()[0]
            # An initially empty tag stays available, waiting for its first contacts.
            if not count or unfinished or pending or listed:return False
            # An empty downstream queue may still receive work from an active producer.
            if self.active_producer(conn,agent):return False
            reason=f'Fila concluída: nenhum contato elegível permanece com a tag “{agent["target_tag"]}”. Todos os {count} atendimento(s) registrados foram finalizados com a troca de etiquetas confirmada, sem ações pendentes.'
            conn.execute("""UPDATE agents SET enabled=0,revision=revision+1,runtime_status='completed',runtime_error='',
                stop_code='completed',stop_reason=?,stopped_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),retry_at=0,retry_count=0,
                updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=? AND enabled=1 AND revision=?""",
                (reason,agent['id'],agent['revision']))
            return True

    def run_job(self,agent,key,job):
        decision=json.loads(job['decision'])
        routes=output_routes(agent)
        selected=decision.get('exit_tag') or (agent['exit_tag'] if len(routes)<=1 else '')
        phone=decision.get('handoff_contact_phone','').strip()
        if decision['action']=='handoff' and phone:
            if not re.fullmatch(r'[1-9]\d{9,14}',phone) or not re.search(r'(?<!\d)'+re.escape(phone)+r'(?!\d)',agent['instructions']) or decision['handoff_group_name'].strip():
                raise BrainError('O contato de resumo não aparece nas instruções do agente ou há mais de um destino. Confira o cadastro.')
        if decision['action']=='handoff' and selected not in [route['tag'] for route in routes]:
            raise BrainError('A decisão não selecionou uma tag de saída cadastrada. Confira as condições do agente.')
        if decision['action']=='handoff' and decision['handoff_group_name'].strip() and decision['handoff_group_name'].strip().casefold() not in agent['instructions'].casefold():
            raise BrainError('O grupo de handoff não aparece nas instruções do agente. Confira o cadastro.')
        args={'chat_id':job['chat_id']}|scope_args(agent,selected if decision['action']=='handoff' else None)
        stage=job['stage']
        if stage=='uncertain':
            raise ConnectionError('Há um envio com resultado incerto. Confira a conversa antes de retomar; ele não será repetido automaticamente.')
        if stage=='planned':
            if decision['reply'].strip():
                self.checked_action(agent,key,'send_agent_reply',args|{'body':decision['reply'],'request_id':job['id']+'-reply'},job['id'])
            self.update_job(job['id'],'reply_done');stage='reply_done'
        if decision['action']=='handoff':
            if stage in ('reply_done','summary_pending'):
                group=decision['handoff_group_name'].strip()
                if group or phone:
                    if group and group.casefold() not in agent['instructions'].casefold():
                        raise BrainError('O grupo de handoff não aparece nas instruções do agente. Confira o cadastro.')
                    summary=f"Handoff · {agent['name']}\nContato: {job['chat_id'].split('@')[0]}\n\n{decision['handoff_summary']}"
                    try:
                        destination={'contact_phone':phone} if phone else {'group_name':group}
                        self.checked_action(agent,key,'send_agent_handoff_summary',destination|{'body':summary,'request_id':job['id']+'-summary'},job['id'])
                    except ConnectionError as error:
                        # This exact MCP preflight rejection happens before once()
                        # or sendMessage(). Other send failures remain uncertain.
                        if str(error) not in ('O grupo de handoff não foi encontrado de forma única. Confira o nome nas instruções.','O contato de resumo não foi encontrado no WhatsApp. Confira o número nas instruções.'):
                            raise
                        self.update_job(job['id'],'summary_pending')
                        raise SummaryPending() from None
                self.update_job(job['id'],'summary_done');stage='summary_done'
            if stage=='summary_done':
                try:
                    result=self.checked_action(agent,key,'handoff_agent_contact',args)
                except ConnectionError as error:
                    if 'O WhatsApp não confirmou a troca das etiquetas.' in str(error):
                        raise HandoffPending() from None
                    raise
                if not (result.get('completed') or result.get('already_completed')):
                    raise HandoffPending()
                with db() as conn:
                    conn.execute('UPDATE agent_sessions SET completed=1,summary=? WHERE agent_id=? AND chat_id=?',
                                 (decision['handoff_summary'],agent['id'],job['chat_id']))
                    conn.execute("UPDATE agent_contacts SET status='completed',result_tag=?,error='' WHERE agent_id=? AND chat_id=?",(selected,agent['id'],job['chat_id']))
        self.update_job(job['id'],'done')

    def process_contact(self,agent,key,chat):
        if not self.current(agent): raise ScopeChanged()
        chat_id=chat['chat_id']
        with db() as conn:
            job=conn.execute("SELECT * FROM agent_jobs WHERE agent_id=? AND chat_id=? AND stage!='done' ORDER BY created_at LIMIT 1",(agent['id'],chat_id)).fetchone()
        if job:
            self.run_job(agent,key,dict(job));return
        context=mcp.call_tool(key,'get_agent_chat_state',{'chat_id':chat_id}|scope_args(agent))
        if not context['eligible']: return
        messages=sorted((item for item in context['messages'] if item.get('type') not in ('e2e_notification','gp2','protocol')),key=lambda item:item.get('timestamp') or 0)
        incoming=[item for item in messages if not item.get('from_me')]
        latest_incoming=incoming[-1].get('message_id','') if incoming else ''
        with db() as conn:
            session=conn.execute('SELECT * FROM agent_sessions WHERE agent_id=? AND chat_id=?',(agent['id'],chat_id)).fetchone()
            if session and session['completed']:
                # Explicitly re-applying entry and removing exit starts a new cycle.
                conn.execute('DELETE FROM agent_sessions WHERE agent_id=? AND chat_id=?',(agent['id'],chat_id))
                session=None
        started=bool(session and session['started'])
        fingerprint=guidance_key(agent)
        reviewing=bool(started and session['guidance_key']!=fingerprint)
        if started and not reviewing and (not latest_incoming or latest_incoming==session['last_incoming']): return
        self.status(agent,'working')
        self.heartbeat()
        with db() as conn:
            listed=conn.execute('SELECT name FROM agent_contacts WHERE agent_id=? AND chat_id=?',(agent['id'],chat_id)).fetchone()
        decision=brain.decide(agent,{'current_datetime':datetime.now(ZoneInfo('America/Sao_Paulo')).isoformat(),'current_timezone':'America/Sao_Paulo','contact_name':(listed['name'] if listed and listed['name'] else chat.get('name','')),'start_conversation':not started,'reviewing_updated_guidance':reviewing,
            'messages':[{'from_me':bool(item.get('from_me')),'body':item.get('body','')[:1500],
                         'type':item.get('type'),'has_media':bool(item.get('has_media'))} for item in messages[-30:]]})
        if not self.current(agent): raise ScopeChanged()
        with action_lock(DATA),db() as conn:
            if not self.current(agent):raise ScopeChanged()
            conn.execute('INSERT INTO agent_sessions (agent_id,chat_id,started,last_incoming) VALUES (?,?,1,?) ON CONFLICT(agent_id,chat_id) DO UPDATE SET started=1,last_incoming=excluded.last_incoming',
                         (agent['id'],chat_id,latest_incoming))
            conn.execute('UPDATE agent_sessions SET guidance_key=? WHERE agent_id=? AND chat_id=?',(fingerprint,agent['id'],chat_id))
            if decision['action']=='wait': return
            job_id=uuid.uuid4().hex
            conn.execute('INSERT INTO agent_jobs (id,agent_id,chat_id,decision) VALUES (?,?,?,?)',
                         (job_id,agent['id'],chat_id,json.dumps(decision,ensure_ascii=False)))
        self.run_job(agent,key,{'id':job_id,'chat_id':chat_id,'decision':json.dumps(decision),'stage':'planned'})

    def cycle(self):
        self.heartbeat()
        with db() as conn:
            agents=[dict(row) for row in conn.execute('''SELECT agents.*,whatsapps.mcp_key,
                m.identity AS shared_identity,m.context AS shared_context,m.name AS base_name
                FROM agents JOIN whatsapps ON whatsapps.id=agents.whatsapp_id
                LEFT JOIN agent_modals m ON m.id=agents.modal_id
                WHERE enabled=1 ORDER BY COALESCE(m.rowid,agents.rowid),agents.flow_position,agents.rowid''')]
        for agent in agents:
            if agent['retry_at']>time.time():continue
            if agent['shared_identity'] is not None:
                agent['identity'] = agent['shared_identity']
                agent['context'] = agent['shared_context']
            key=agent['mcp_key']
            try:
                if not key: raise ConnectionError('O WhatsApp selecionado não está configurado.')
                self.enroll_contacts(agent,key)
                with db() as conn:
                    pending=[dict(row) for row in conn.execute("SELECT * FROM agent_jobs WHERE agent_id=? AND stage!='done' ORDER BY created_at,id",(agent['id'],))]
                offset=self.job_cursors.get(agent['id'],0)%max(len(pending),1)
                jobs=(pending[offset:]+pending[:offset])[:5]
                self.job_cursors[agent['id']]=(offset+5)%max(len(pending),1)
                attempted=set()
                for job in jobs:
                    attempted.add(job['chat_id'])
                    try:self.run_job(agent,key,job)
                    except HandoffPending:pass
                result=mcp.call_tool(key,'get_chats_by_entry_tag',scope_args(agent))
                chats=result['chats']
                self.track_contacts(agent,chats)
                offset=self.cursors.get(agent['id'],0)%max(len(chats),1)
                batch=(chats[offset:]+chats[:offset])[:5]
                self.cursors[agent['id']]=(offset+5)%max(len(chats),1)
                for chat in batch:
                    if chat['chat_id'] in attempted:continue
                    self.heartbeat()
                    try:self.process_contact(agent,key,chat)
                    except HandoffPending:pass
                if self.finish_if_complete(agent,chats):continue
                with db() as conn:
                    confirming=conn.execute("SELECT COUNT(*) FROM agent_jobs WHERE agent_id=? AND stage='summary_done'",(agent['id'],)).fetchone()[0]
                    summaries=conn.execute("SELECT COUNT(*) FROM agent_jobs WHERE agent_id=? AND stage='summary_pending'",(agent['id'],)).fetchone()[0]
                    upstream=not chats and self.active_producer(conn,agent)
                    unfinished=conn.execute('SELECT COUNT(*) FROM agent_sessions WHERE agent_id=? AND completed=0',(agent['id'],)).fetchone()[0]
                    list_errors=conn.execute("SELECT COUNT(*) FROM agent_contacts WHERE agent_id=? AND status='error'",(agent['id'],)).fetchone()[0]
                    conn.execute('UPDATE agents SET retry_at=0,retry_count=0 WHERE id=? AND enabled=1 AND revision=?',(agent['id'],agent['revision']))
                status,message='waiting',''
                if chats:
                    status,message='waiting_reply',f'{len(chats)} contato(s) na entrada “{agent["target_tag"]}”. Atendimentos já avaliados aguardam nova resposta; use o chat IA para diagnosticar ou solicitar reavaliação.'
                else:
                    message=f'Nenhum contato elegível encontrado na entrada “{agent["target_tag"]}” deste WhatsApp. Contatos com uma tag de saída são excluídos.'
                if summaries:
                    status,message='attention',f'Há {summaries} resumo(s) pendente(s): o destino indicado nas instruções não foi encontrado neste WhatsApp. Confira o grupo ou número do contato de resumo. O agente continua ligado atendendo os demais contatos; respostas já enviadas não serão repetidas e as etiquetas destes resumos só serão concluídas após o envio confirmado.'
                elif confirming:
                    status,message='waiting_tags',f'Aguardando confirmação das etiquetas de {confirming} contato(s). O agente continua ligado e os demais atendimentos continuam; mensagens já enviadas não serão repetidas.'
                elif not chats and unfinished:
                    status,message='attention',f'Há {unfinished} atendimento(s) sem conclusão confirmada, embora a consulta não encontre contatos elegíveis. Confira as etiquetas: retirar a tag manualmente não confirma o objetivo. O agente continua ligado.'
                elif upstream:
                    status,message='waiting_upstream','A fila está vazia neste momento, mas há outro agente ligado que pode encaminhar contatos para esta tag. Aguardando as etapas anteriores.'
                if list_errors:
                    status,message='attention',message+f' Há {list_errors} contato(s) da lista que precisam de correção. Abra Lista de Contatos para conferir.'
                self.status(agent,status,message)
            except ScopeChanged:
                pass
            except (TemporaryConnectionError,TemporaryBrainError) as error:
                try:self.retry_later(agent,str(error))
                except ScopeChanged:pass
            except (ConnectionError,BrainError) as error:
                self.pause(agent,str(error))
            except Exception:
                self.pause(agent,'Não foi possível concluir a operação. O agente foi pausado para você conferir.')


if __name__=='__main__':
    running=True
    def stop(*args):
        global running
        running=False
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    worker=AgentWorker()
    print('Serviço de agentes pronto. Apenas agentes ligados pelo usuário serão executados.',flush=True)
    while running:
        worker.cycle()
        for _ in range(20):
            if not running: break
            time.sleep(1)
    with db() as conn: conn.execute("DELETE FROM settings WHERE key='worker_heartbeat'")
