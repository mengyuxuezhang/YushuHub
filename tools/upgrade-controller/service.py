"""One registered-instance Unix socket. No arbitrary commands, files or release paths."""
import http.server
import json
import os
import re
import socket
import socketserver
import stat
import threading
import uuid
from pathlib import Path
from catalog import refresh_catalog
from controller import Controller, TERMINAL
from state import Journal, atomic_json, locks


def public_status(control, instance):
    cfg = control.config(instance)
    desired, source_warning = refresh_catalog(control, cfg)
    release = control.release(desired) if desired else {}
    directory = Path(cfg['stateDir'])
    record = Journal(directory).read() or {}
    current_file = directory / 'current.json'
    current = json.loads(current_file.read_text()).get('release', {}) if current_file.exists() else {}
    request_file = directory / 'last-request.json'
    request = json.loads(request_file.read_text()) if request_file.exists() else {}
    availability = 'unregistered'
    if current:
        try:
            container = control.engine.container(cfg['containerName'])
            availability = 'running' if container and container['State']['Running'] and container['Config']['Image'] == current.get('image') else 'stopped-or-different'
        except Exception:
            availability = 'unknown'
    if request and request.get('operationId') != record.get('operationId') and (not record or record.get('stage') in TERMINAL):
        record = request
    transaction = {key: record.get(key) for key in ('operationId', 'stage', 'updatedAt', 'error') if key in record}
    if transaction.get('error') and not re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', transaction['error']):
        transaction['error'] = 'CONTROLLER_OPERATION_FAILED'
    return {'protocolVersion': 1, 'deploymentMode': 'docker', 'instanceId': instance,
        'configured': bool(desired), 'currentVersion': current.get('version'), 'latestVersion': release.get('version'),
        'releaseId': desired, 'releaseNotes': release.get('releaseNotes', ''), 'publishedAt': release.get('publishedAt', ''),
        'sourceWarning': source_warning, 'transaction': transaction,
        'runtimeAvailability': availability,
        'history': cfg.get('releaseHistory', [])}


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(10)
        return request, address

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()


def serve_instance(control, instance, socket_path=None, stop_event=None):
    with locks(control.root, ['service:' + instance]):
        return _serve_instance(control, instance, socket_path, stop_event)


def _serve_instance(control, instance, socket_path=None, stop_event=None):
    cfg = control.config(instance)
    path = Path(socket_path or ('/run/yushuhub-upgrade/' + instance + '/control.sock'))
    path.parent.mkdir(parents=True, mode=0o755, exist_ok=True)
    if path.parent.is_symlink() or path.parent.stat().st_uid != 0 or path.parent.stat().st_mode & 0o022:
        raise ValueError('CONTROLLER_SOCKET_DIRECTORY_MUST_BE_ROOT_CONTROLLED')
    if path.exists():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise ValueError('CONTROLLER_SOCKET_PATH_IS_NOT_A_SOCKET')
        with socket.socket(socket.AF_UNIX) as probe:
            probe.settimeout(0.5)
            try:
                probe.connect(str(path))
            except (ConnectionRefusedError, FileNotFoundError):
                path.unlink(missing_ok=True)
            else:
                raise ValueError('CONTROLLER_SOCKET_ALREADY_ACTIVE')
    active = threading.Lock()
    try:
        with locks(control.root, ['host-cutover', 'instance:' + instance]):
            journal = Journal(cfg['stateDir'])
            pending = journal.read()
            if pending and pending.get('stage') not in TERMINAL:
                journal.save(pending, 'needs_attention', error='CONTROLLER_RESTART_INTERRUPTED_OPERATION')
            request_path = Path(cfg['stateDir']) / 'last-request.json'
            request = json.loads(request_path.read_text()) if request_path.exists() else {}
            if request.get('stage') == 'accepted' and request.get('operationId') != (pending or {}).get('operationId'):
                request.update(stage='failed', error='CONTROLLER_RESTART_BEFORE_OPERATION_STARTED')
                atomic_json(request_path, request)
    except RuntimeError:
        # A CLI operation is still alive and holds the shared kernel lock.
        pass

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.headers.get('X-Yushuhub-Instance') != instance:
                return self.reply(409, {'error': 'INSTANCE_BINDING_MISMATCH'})
            if self.path != '/v1/status':
                return self.reply(404, {'error': 'NOT_FOUND'})
            try:
                self.reply(200, public_status(control, instance))
            except Exception:
                self.reply(503, {'error': 'CONTROLLER_STATUS_UNAVAILABLE'})

        def do_POST(self):
            try:
                if self.headers.get('Transfer-Encoding'):
                    return self.reply(400, {'error': 'UNSUPPORTED_REQUEST_ENCODING'})
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 <= size <= 1024:
                    return self.reply(413, {'error': 'REQUEST_TOO_LARGE'})
                raw = self.rfile.read(size)
                if len(raw) != size:
                    return self.reply(400, {'error': 'INCOMPLETE_REQUEST'})
                if self.headers.get('X-Yushuhub-Instance') != instance:
                    return self.reply(409, {'error': 'INSTANCE_BINDING_MISMATCH'})
                if self.path not in ('/v1/upgrade', '/v1/rollback', '/v1/recover'):
                    return self.reply(404, {'error': 'NOT_FOUND'})
                payload = json.loads(raw or b'{}')
                if not isinstance(payload, dict) or set(payload) - {'operationId'}:
                    return self.reply(400, {'error': 'UNSUPPORTED_REQUEST_FIELDS'})
                operation = payload.get('operationId') or str(uuid.uuid4())
                if not isinstance(operation, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,80}', operation):
                    return self.reply(400, {'error': 'INVALID_OPERATION_ID'})
                if not active.acquire(blocking=False):
                    return self.reply(409, {'error': 'UPGRADE_ALREADY_RUNNING'})
                try:
                    desired, _ = refresh_catalog(control, control.config(instance))
                    if self.path == '/v1/upgrade' and not desired:
                        raise ValueError('NO_APPROVED_RELEASE')
                    request = {'operationId': operation, 'stage': 'accepted', 'action': self.path.rsplit('/', 1)[1]}
                    atomic_json(Path(cfg['stateDir']) / 'last-request.json', request)
                except Exception:
                    active.release()
                    raise

                def worker(action):
                    try:
                        if action == 'upgrade':
                            result = control.apply(instance, desired, operation)
                        else:
                            result = control.recover(instance, rollback_committed=action == 'rollback')
                        request.update(stage=result['stage'])
                    except Exception as error:
                        code = str(error)
                        request.update(stage='failed', error=code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,120}', code) else 'CONTROLLER_OPERATION_FAILED')
                    finally:
                        atomic_json(Path(cfg['stateDir']) / 'last-request.json', request)
                        active.release()
                threading.Thread(target=worker, args=(request['action'],), daemon=False).start()
                self.reply(202, {'operationId': operation, 'stage': 'accepted'})
            except Exception:
                self.reply(400, {'error': 'CONTROLLER_REQUEST_REJECTED'})

    server = UnixHTTPServer(str(path), Handler)
    os.chown(path, 1000, 1000)
    os.chmod(path, 0o600)
    try:
        if stop_event is None:
            server.serve_forever(poll_interval=0.2)
        else:
            server.timeout = 0.2
            while not stop_event.is_set():
                server.handle_request()
    finally:
        server.server_close()
        path.unlink(missing_ok=True)
