from contextlib import contextmanager
import fcntl

@contextmanager
def action_lock(data):
    # The web process and the worker share this lock. Once pause returns,
    # no old scope can issue another outgoing action.
    with (data / 'agent-actions.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        try: yield
        finally: fcntl.flock(lock,fcntl.LOCK_UN)
