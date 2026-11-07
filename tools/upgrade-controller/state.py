"""Crash-durable state and kernel-held locks (Linux controller only)."""
import contextlib
import hashlib
import json
import os
from pathlib import Path


def atomic_json(path, body):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.next')
    with temporary.open('w', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(body, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    if os.name == 'posix':
        fd = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


@contextlib.contextmanager
def locks(root, keys):
    import fcntl
    directory = Path(root) / 'locks'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    handles = []
    try:
        for key in sorted(set(keys)):
            name = hashlib.sha256(key.encode()).hexdigest()
            stream = (directory / (name + '.lock')).open('a')
            handles.append(stream)
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('INSTANCE_OR_DATABASE_BUSY') from None
        yield
    finally:
        for stream in reversed(handles):
            stream.close()


class Journal:
    def __init__(self, directory):
        self.directory = Path(directory)

    def read(self):
        try:
            return json.loads((self.directory / 'transaction.json').read_text())
        except FileNotFoundError:
            return None

    def save(self, record, stage, **extra):
        import datetime
        record.update(extra, stage=stage, updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        atomic_json(self.directory / 'transaction.json', record)
        if record.get('operationId'):
            atomic_json(self.directory / 'operations' / (record['operationId'] + '.json'), record)
        return record
