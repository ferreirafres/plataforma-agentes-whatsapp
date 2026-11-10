"""Bounded, authenticated audio transcription. Audio is never persisted."""
import json
import secrets
import threading
import urllib.request
import urllib.error
from pathlib import Path

MAX_AUDIO=12*1024*1024
TYPES={'webm':'audio/webm','ogg':'audio/ogg','mp3':'audio/mpeg','mpga':'audio/mpeg','mpeg':'audio/mpeg',
       'm4a':'audio/mp4','mp4':'audio/mp4','wav':'audio/wav','flac':'audio/flac'}


def valid_audio(data,extension):
    if extension=='webm':return data.startswith(b'\x1aE\xdf\xa3')
    if extension=='ogg':return data.startswith(b'OggS')
    if extension=='wav':return data.startswith(b'RIFF') and data[8:12]==b'WAVE'
    if extension=='flac':return data.startswith(b'fLaC')
    if extension in ('m4a','mp4'):return data[4:8]==b'ftyp'
    return data.startswith(b'ID3') or (len(data)>1 and data[0]==255 and data[1]&224==224)


def transcribe(brain,data,extension):
    from openai_brain import BrainError
    config=brain.config()
    if not config.get('api_key'):raise BrainError('A chave da OpenAI ainda não está configurada.')
    boundary='audio-'+secrets.token_hex(24)
    parts=[]
    for name,value in [('model',config.get('transcription_model','gpt-transcribe')),('language','pt'),('response_format','json')]:
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="mensagem.{extension}"\r\nContent-Type: {TYPES[extension]}\r\n\r\n'.encode()+data+b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    req=urllib.request.Request('https://api.openai.com/v1/audio/transcriptions',data=b''.join(parts),
        headers={'Authorization':'Bearer '+config['api_key'],'Content-Type':'multipart/form-data; boundary='+boundary})
    try:
        with urllib.request.urlopen(req,timeout=90) as response:result=json.loads(response.read(128*1024))
    except urllib.error.HTTPError as error:
        messages={400:'Não foi possível reconhecer este áudio. Tente gravar novamente ou usar outro formato.',
            401:'A chave da OpenAI não foi aceita para transcrição.',403:'A conta não tem acesso ao modelo de transcrição.',
            404:'O modelo de transcrição configurado não está disponível.',429:'A transcrição está com limite de uso. Tente novamente em instantes.'}
        raise BrainError(messages.get(error.code,'O serviço de transcrição está indisponível. Tente novamente.')) from None
    except (OSError,ValueError):raise BrainError('Não foi possível receber a transcrição. Seu áudio não foi enviado como comando.') from None
    text=result.get('text')
    if not isinstance(text,str) or not text.strip():raise BrainError('Não foi identificada fala no áudio. Tente novamente.')
    if len(text)>6000:raise BrainError('A transcrição ultrapassou 6.000 caracteres. Envie um áudio menor.')
    return text.strip()


def register(app,auth_required,db,brain,fail):
    from flask import request,jsonify
    from openai_brain import BrainError
    slots=threading.BoundedSemaphore(2)

    @app.post('/api/agents/<aid>/chat/transcribe')
    @app.post('/api/agent-modals/<mid>/chat/transcribe')
    @auth_required
    def audio(aid=None,mid=None):
        with db() as c:
            exists=c.execute('SELECT 1 FROM '+('agents' if aid else 'agent_modals')+' WHERE id=?',(aid or mid,)).fetchone()
        if not exists:return fail('Agente ou modal não encontrado.',404)
        file=request.files.get('audio')
        if not file:return fail('Selecione ou grave um áudio.')
        extension=Path(file.filename or '').suffix.lower().lstrip('.')
        if extension not in TYPES:return fail('Use áudio WebM, OGG, MP3, M4A, MP4, WAV ou FLAC.')
        if not slots.acquire(blocking=False):return fail('Há outras transcrições em andamento. Tente novamente em instantes.',429)
        try:
            data=file.read(MAX_AUDIO+1)
            if len(data)>MAX_AUDIO:return fail('O áudio ultrapassa 12 MB. Envie um arquivo menor.',413)
            if not valid_audio(data,extension):return fail('O arquivo não foi reconhecido como áudio no formato informado.')
            text=transcribe(brain,data,extension)
            return jsonify(text=text,notice='Transcrição pronta. Revise o texto e envie para aplicar sua orientação.')
        except BrainError as error:return fail(str(error),409)
        finally:slots.release()
