"""Crash-durable state and kernel-held locks (Linux controller only)."""
import contextlib
import hashlib
import json
import os
import datetime
import re
from pathlib import Path


def atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.next')
    with temporary.open('wb') as stream:
        os.chmod(temporary, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    if os.name == 'posix':
        fd = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


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
def locks(root, keys, shared=False):
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
                fcntl.flock(stream, (fcntl.LOCK_SH if shared else fcntl.LOCK_EX) | fcntl.LOCK_NB)
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
        record.update(extra, stage=stage, **event_stamp(self.directory))
        atomic_json(self.directory / 'transaction.json', record)
        if record.get('operationId'):
            atomic_json(self.directory / 'operations' / (record['operationId'] + '.json'), record)
        return record


def event_stamp(directory):
    """Root-issued persistent ordering shared by HTTP, CLI and journal writers."""
    import fcntl
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'event-order.lock').open('a+') as stream:
        os.chmod(stream.name, 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        counter = directory / 'event-order.json'
        sequence = (json.loads(counter.read_text()) if counter.exists() else 0) + 1
        atomic_json(counter, sequence)
    return {'eventSequence': sequence, 'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}


def latest_record(record, request):
    record, request = record or {}, request or {}
    if not request:
        return record
    if not record:
        return request
    if record.get('stage') not in {'committed', 'rolled_back', 'rejected', 'failed'}:
        return record
    # Legacy records have no sequence. Unknown-age requests never hide a journal.
    if record.get('eventSequence') is not None and request.get('eventSequence') is not None:
        newer = request['eventSequence'] > record['eventSequence']
    else:
        newer = bool(request.get('updatedAt') and request['updatedAt'] > record.get('updatedAt', ''))
    return request if newer else record


def request_file(directory, operation):
    if not isinstance(operation, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', operation):
        raise ValueError('INVALID_OPERATION_ID')
    return Path(directory) / 'requests' / (operation + '.json')


def find_request(directory, operation, intent):
    path = request_file(directory, operation)
    if not path.exists():
        return None
    record = json.loads(path.read_text())
    if record['intent'] != intent:
        raise ValueError('OPERATION_ID_REUSED_WITH_DIFFERENT_INTENT')
    return record


@contextlib.contextmanager
def request_guard(directory):
    import fcntl
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / 'request-state.lock').open('a') as stream:
        os.chmod(stream.name, 0o600)
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def _save_request(directory, record):
    record.update(event_stamp(directory))
    atomic_json(request_file(directory, record['operationId']), record)
    atomic_json(Path(directory) / 'last-request.json', record)
    return record


def save_request(directory, record, publish=True):
    with request_guard(directory):
        if not publish:
            atomic_json(request_file(directory, record['operationId']), record)
            latest = Path(directory) / 'last-request.json'
            if latest.exists() and json.loads(latest.read_text()).get('operationId') == record['operationId']:
                atomic_json(latest, record)
            return record
        return _save_request(directory, record)


def reserve_request(directory, operation, intent):
    with request_guard(directory):
        previous = find_request(directory, operation, intent)
        if previous:
            return previous
        return _save_request(directory, {'operationId': operation, 'intent': intent, 'stage': 'accepted'})


def request_result(record):
    return record.get('result') or {key: record[key] for key in ('operationId', 'stage', 'error') if key in record}


def execution_key(directory, operation):
    request_file(directory, operation)  # Validate before using the ID in a lock key.
    return 'request-execution:' + str(Path(directory).resolve()) + ':' + operation


def _interrupted_request(directory, record):
    if record['stage'] == 'running':
        record.update(stage='needs_attention', error='REQUEST_OUTCOME_REQUIRES_RECOVERY')
        save_request(directory, record, publish=False)
    return request_result(record)


def replay_request(root, directory, operation, intent):
    """All entry points use the exact request's execution lock, not a PID guess.

    A different task holding the host lock cannot make an orphan receipt look live.
    Reclassification preserves event order and never calls a business callback.
    """
    record = find_request(directory, operation, intent)
    if not record:
        return None
    if record['stage'] != 'running':
        return request_result(record)
    try:
        # Shared probes do not mistake another replay/classification for a live
        # exclusive executor. The request-state lock serializes receipt writes.
        with locks(root, [execution_key(directory, operation)], shared=True):
            # Re-read after acquiring: the executor may have just committed its result.
            return _interrupted_request(directory, find_request(directory, operation, intent))
    except RuntimeError as error:
        if str(error) != 'INSTANCE_OR_DATABASE_BUSY':
            raise
        return request_result(find_request(directory, operation, intent))


def execute_request(directory, operation, intent, callback, root=None):
    """Caller holds the host/instance lock. Hold a per-request lock through effects
    and final receipt persistence so HTTP and executable retries can prove liveness.
    """
    # Production callers always pass the canonical controller root. The fallback
    # keeps standalone state-only callers isolated without sharing a global lock.
    root = root or Path(directory)
    record = reserve_request(directory, operation, intent)
    if record['stage'] != 'accepted':
        return replay_request(root, directory, operation, intent)
    with locks(root, [execution_key(directory, operation)]):
        record['stage'] = 'running'
        save_request(directory, record)
        try:
            result = callback()
            result = dict(result, operationId=operation, targetOperationId=result.get('operationId'))
            record.update(stage=result['stage'], result=result)
            record.pop('error', None)
            save_request(directory, record)
            return result
        except Exception as error:
            code = str(error)
            record.update(stage='failed', error=code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', code) else 'CONTROLLER_OPERATION_FAILED')
            save_request(directory, record)
            raise
