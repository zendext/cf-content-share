"""Standalone client regressions; every HTTP assertion uses a real TCP server."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'skills/cf-content-share/scripts/upload.py'
TOKEN = '.'.join(['a' * 43] * 3)


class RuntimeTest(unittest.TestCase):
    def test_copied_skill_runs_outside_repository(self):
        self.assertTrue(SCRIPT.is_file(), 'Standalone Python upload helper is missing')
        with tempfile.TemporaryDirectory(prefix='中文 Skill ') as directory:
            installed = Path(directory) / 'installed skill'
            shutil.copytree(SCRIPT.parent.parent, installed)
            result = subprocess.run([sys.executable, str(installed / 'scripts/upload.py'), '--help'],
                                    cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Python 3.12+', result.stdout)
            self.assertFalse((installed / 'node_modules').exists())



spec = importlib.util.spec_from_file_location('upload', SCRIPT)
upload = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upload)


class HTTPServer:
    """Raw socket fixture permits malformed and early HTTP responses."""
    def __init__(self, response=b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n', early=False, hold=False, tls=False, interim=None):
        self.response, self.early, self.hold = response, early, hold
        self.interim = interim
        self.tls = None
        if tls:
            self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            self.tls.load_cert_chain(Path(__file__).with_name('localhost-cert.pem'), Path(__file__).with_name('localhost-key.pem'))
        self.requests = []
        self.ready = threading.Event()
        self.stopped = threading.Event()
        self.sock = socket.socket()
        self.sock.bind(('127.0.0.1', 0))
        self.sock.listen()
        self.sock.settimeout(0.2)
        self.origin = f'{"https" if tls else "http"}://127.0.0.1:{self.sock.getsockname()[1]}'
        self.thread = threading.Thread(target=self.run, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        self.stopped.set()
        self.sock.close()
        self.thread.join(5)
        assert not self.thread.is_alive(), 'HTTP fixture did not stop'

    def run(self):
        while not self.stopped.is_set():
            try:
                connection, _peer = self.sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            connection.settimeout(2)
            if self.tls is not None:
                try:
                    connection = self.tls.wrap_socket(connection, server_side=True)
                except OSError:
                    connection.close()
                    continue
            with connection:
                connection.settimeout(2)
                data = b''
                try:
                    while b'\r\n\r\n' not in data:
                        part = connection.recv(65536)
                        if not part:
                            break
                        data += part
                    header, body = data.split(b'\r\n\r\n', 1)
                    headers = {line.split(b':', 1)[0].decode().lower(): line.split(b':', 1)[1].strip().decode()
                               for line in header.split(b'\r\n')[1:]}
                    request = {'headers': headers, 'line': header.split(b'\r\n')[0], 'body': body}
                    self.requests.append(request)
                    self.ready.set()
                    if self.interim is not None:
                        connection.sendall(self.interim)
                    if not self.early:
                        while len(body) < int(headers['content-length']):
                            part = connection.recv(65536)
                            if not part:
                                break
                            body += part
                        request['body'] = body
                    if self.response is not None:
                        connection.sendall(self.response)
                    if self.hold:
                        self.stopped.wait(2)
                except (OSError, ValueError):
                    pass


def response(status=200, body=b'', chunked=False):
    if chunked:
        return f'HTTP/1.1 {status} Test\r\nTransfer-Encoding: chunked\r\n\r\n'.encode() + f'{len(body):x}\r\n'.encode() + body + b'\r\n0\r\n\r\n'
    return f'HTTP/1.1 {status} Test\r\nContent-Length: {len(body)}\r\n\r\n'.encode() + body


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='分享 路径 ')
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.file = self.directory / '图片 文件.svg'
        self.state = self.directory / 'state.json'
        self.metadata_file = self.directory / 'metadata.json'
        self.contract_file = self.directory / 'contract.json'
        self.authorization_file = self.directory / 'authorization.json'
        self.original = '<svg>原始字节</svg>'.encode()
        self.file.write_bytes(self.original)
        self.metadata = {'filename': '图片.svg', 'content_type': 'image/svg+xml', 'title': '分享图片', 'tags': ['资料']}
        self.origin = 'https://share.example.test'
        self.set_origin(self.origin)
        self.save(self.metadata_file, self.metadata)

    def save(self, file, value):
        file.write_text(json.dumps(value, ensure_ascii=True), encoding='utf-8')
        file.chmod(0o600)

    def set_origin(self, origin):
        self.origin = origin
        self.contract = {'protocol_version': 2, 'url': origin + '/mcp/upload', 'method': 'POST',
                         'authorization': 'Cf-Access-Token: <token>', 'generated_fields': list(upload.GENERATED_FIELDS),
                         'max_metadata_bytes': 16384, 'metadata_schema': {'type': 'object'}}
        self.authorization = {'token': TOKEN, 'expires_at': int(time.time()) + 3600,
                        'upload': {'url': origin + '/mcp/upload', 'method': 'POST', 'protocol_version': 2, 'authorization': 'Cf-Access-Token: <token>'}}
        self.save(self.contract_file, self.contract)
        self.save(self.authorization_file, self.authorization)

    def prepare(self, state=None, **changes):
        return upload.prepare_upload(**{'file': str(self.file), 'origin': self.origin,
                                       'state_file': str(state or self.state), 'metadata_file': str(self.metadata_file),
                                       'contract_file': str(self.contract_file), **changes})

    def send(self, state=None, **changes):
        return upload.send_upload(**{'state_file': str(state or self.state), 'authorization_file': str(self.authorization_file), **changes})

    def assert_error(self, code, operation, **kwargs):
        with self.assertRaises(upload.UploadError) as context:
            operation(**kwargs)
        self.assertEqual(context.exception.code, code)

    def cli(self, arguments, script=SCRIPT, env=None):
        return subprocess.run([sys.executable, str(script), *arguments], cwd=self.directory,
                              capture_output=True, encoding='utf-8', env=env, timeout=10)

    def args(self):
        return ['prepare', '--file', str(self.file), '--origin', self.origin, '--metadata-file', str(self.metadata_file),
                '--contract-file', str(self.contract_file), '--state-file', str(self.state)]

    def test_01_prepare_private_immutable_state_dynamic_metadata(self):
        result = self.prepare()
        raw = self.state.read_bytes()
        state = json.loads(raw)
        self.assertEqual(state['version'], 2)
        self.assertEqual(state['file'], str(self.file.absolute()))
        self.assertEqual(state['origin'], self.origin)
        self.assertEqual(state['protocol']['protocol_version'], 2)
        self.assertRegex(result['operation_id'], r'^[0-9a-f-]{36}$')
        self.assertEqual(state['metadata'], {**self.metadata, 'operation_id': result['operation_id'],
                                            'size_bytes': len(self.original), 'sha256': hashlib.sha256(self.original).hexdigest()})
        if os.name != 'nt':
            self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
        self.assert_error('STATE_EXISTS', self.prepare)
        self.assertEqual(self.state.read_bytes(), raw)

    def test_02_omitted_null_nested_numeric_without_business_validation(self):
        with HTTPServer(response(202, b'{"resource":{"state":"future_state"}}')) as server:
            self.set_origin(server.origin)
            for index, metadata in enumerate([{'future': {'values': [None, 3.5, False], 'nested': {'title': 'future'}}},
                                              {'retention_seconds': None},
                                              {'retention_seconds': -1, 'content_type': 'server-decides', 'filename': ''}]):
                self.save(self.metadata_file, metadata)
                state = self.directory / f'state{index}.json'
                prepared = self.prepare(state)
                sent = self.send(state)
                saved = json.loads(state.read_bytes())['metadata']
                self.assertEqual({key: value for key, value in saved.items() if key not in upload.GENERATED_FIELDS}, metadata)
                actual = json.loads(server.requests[-1]['body'].split(b'\r\n\r\n')[1].split(b'\r\n--')[0])
                self.assertEqual(actual, saved)
                self.assertEqual(sent, {'exitCode': 0, 'result': {'operation_id': prepared['operation_id'],
                                                                'transport_status': 'response_received', 'http_status': 202}})

    def test_03_reject_generated_malformed_oversized_unsafe_json(self):
        for metadata in [{'operation_id': 'chosen'}, {'size_bytes': 1}, {'sha256': None}, [], None, {'data': 'x' * 16384}]:
            self.save(self.metadata_file, metadata)
            self.assert_error('INVALID_METADATA', self.prepare)
        for raw in ['{', '{"number":1e999}', '{"number":9007199254740993}', '{"number":NaN}',
                    '{"number":Infinity}', '{"nested":' + '[' * 65 + 'null' + ']' * 65 + '}']:
            self.metadata_file.write_text(raw)
            self.assert_error('INVALID_PRIVATE_JSON', self.prepare)

    def test_04_contract_protocol_origin_generated_fields_limits(self):
        for changes in [{'protocol_version': 1}, {'protocol_version': True}, {'method': 'GET'},
                        {'url': 'https://foreign.test/upload'}, {'authorization': 'Bearer secret'},
                        {'generated_fields': ['operation_id', 'size_bytes']}, {'max_metadata_bytes': 131073},
                        {'max_metadata_bytes': 0}, {'max_metadata_bytes': 3.5}, {'max_metadata_bytes': True}]:
            self.save(self.contract_file, {**self.contract, **changes})
            self.assert_error('INVALID_CONTRACT', self.prepare)
        self.save(self.contract_file, {**self.contract, 'metadata_schema': {'properties': {'future': {'type': 'unknown'}}}})
        self.prepare()

    def test_05_dynamic_limit_compact_nested_state(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            nested = {'value': 'x' * 17000}
            for _index in range(50):
                nested = {'nested': nested}
            self.save(self.metadata_file, nested)
            self.save(self.contract_file, {**self.contract, 'max_metadata_bytes': 32768})
            self.prepare()
            saved = json.loads(self.state.read_bytes())
            self.assertEqual(saved['protocol']['max_metadata_bytes'], 32768)
            self.assertEqual(saved['metadata']['nested'], nested['nested'])
            self.assertLess(self.state.stat().st_size, 32768)
            self.assertEqual(self.send()['exitCode'], 0)

    def test_06_reserve_depth_for_state_envelope(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            nested = {'value': None}
            for _index in range(62):
                nested = {'nested': nested}
            self.save(self.metadata_file, nested)
            self.prepare()
            self.assertEqual(self.send()['exitCode'], 0)
            self.save(self.metadata_file, {'nested': nested})
            other = self.directory / 'too-deep.json'
            self.assert_error('INVALID_METADATA', self.prepare, state=other)
            self.assertFalse(other.exists())

    def test_07_real_streaming_source_reads_and_socket_sends_are_bounded(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            self.file.write_bytes(b'Z' * (16 * 1024 * 1024))
            self.save(self.contract_file, {**self.contract, 'max_metadata_bytes': 131072})
            self.save(self.metadata_file, {'future': 'x' * 70000})
            self.prepare()
            reads, writes, handles = [], [], []
            original_open = upload.open_source
            original_send = socket.socket.send

            class ObservedFile:
                def __init__(self, file):
                    self.file = file
                    handles.append(file.fileno())
                def __enter__(self):
                    return self
                def __exit__(self, *args):
                    return self.file.__exit__(*args)
                def __getattr__(self, name):
                    return getattr(self.file, name)
                def read(self, size=-1):
                    reads.append((self.file.fileno(), size))
                    return self.file.read(size)

            def observed_open(filename):
                return ObservedFile(original_open(filename))

            def observed_send(connection, data):
                writes.append(len(data))
                return original_send(connection, data)

            with patch.object(upload, 'open_source', observed_open), patch.object(socket.socket, 'send', observed_send):
                sent = self.send()
            self.assertEqual(sent['exitCode'], 0)
            self.assertEqual(len(handles), 1)
            self.assertTrue(all(0 < size <= 65536 and fd == handles[0] for fd, size in reads))
            self.assertGreater(len(reads), 500)  # hashing and transmission of the same handle
            self.assertGreater(len(writes), 250)
            self.assertLessEqual(max(writes), 65536)
            self.assertEqual(len(server.requests[0]['body']), int(server.requests[0]['headers']['content-length']))

    def test_08_changed_file_bad_authorization_unsafe_origin_before_http(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            self.prepare()
            self.file.write_bytes(b'\0' * len(self.original))
            self.assert_error('FILE_CHANGED', self.send)
            self.file.write_bytes(self.original)
            cases = [({'upload': {**self.authorization['upload'], 'url': 'https://other.example/upload'}}, 'AUTHORIZATION_ORIGIN_MISMATCH'),
                     ({'expires_at': 1}, 'AUTHORIZATION_EXPIRED'), ({'expires_at': True}, 'INVALID_AUTHORIZATION'),
                     ({'token': 'invalid'}, 'INVALID_AUTHORIZATION'),
                     ({'upload': {**self.authorization['upload'], 'method': 'GET'}}, 'INVALID_AUTHORIZATION'),
                     ({'upload': {**self.authorization['upload'], 'protocol_version': 1}}, 'INVALID_AUTHORIZATION'),
                     ({'upload': {**self.authorization['upload'], 'protocol_version': True}}, 'INVALID_AUTHORIZATION'),
                     ({'upload': {'url': self.origin + '/mcp/upload', 'method': 'POST'}}, 'INVALID_AUTHORIZATION'),
                     ({'upload': {**self.authorization['upload'], 'url': self.origin + '/different'}}, 'INVALID_AUTHORIZATION')]
            for changes, code in cases:
                self.save(self.authorization_file, {**self.authorization, **changes})
                self.assert_error(code, self.send)
            for origin in ['http://example.com', 'https://u:p@example.com', 'https://example.com/path']:
                self.assert_error('INVALID_ORIGIN', self.prepare, origin=origin)
            self.assertEqual(server.requests, [])

    def test_08a_cloudflare_credential_uses_private_file_and_exact_header(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            contract = {**self.contract, 'protocol_version': 2, 'url': self.origin + '/mcp/upload',
                        'authorization': 'Cf-Access-Token: <token>'}
            self.save(self.contract_file, contract)
            self.prepare()
            before = self.state.read_bytes()
            credential_file = self.directory / 'authorization.json'
            token = TOKEN
            credentials = {'token': token, 'expires_at': int(time.time()) + 3600, 'upload': contract}
            self.save(credential_file, credentials)
            result = self.cli(['send', '--state-file', str(self.state), '--authorization-file', str(credential_file)])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(token, result.stdout + result.stderr)
            self.assertEqual(server.requests[0]['headers']['cf-access-token'], token)
            self.assertNotIn('authorization', server.requests[0]['headers'])
            self.assertTrue(server.requests[0]['line'].startswith(b'POST /mcp/upload '))
            self.assertEqual(self.state.read_bytes(), before)
            send = lambda: upload.send_upload(state_file=str(self.state), authorization_file=str(credential_file))
            for changes, code in [({'expires_at': 0}, 'AUTHORIZATION_EXPIRED'),
                                  ({'token': token + '\r\nInjected: value'}, 'INVALID_AUTHORIZATION'),
                                  ({'token': token + 'A' * 16384}, 'INVALID_AUTHORIZATION'),
                                  ({'upload': {**contract, 'url': 'https://foreign.test/mcp/upload'}}, 'AUTHORIZATION_ORIGIN_MISMATCH'),
                                  ({'upload': {**contract, 'authorization': 'Bearer <token>'}}, 'INVALID_AUTHORIZATION'),
                                  ({'upload': {**contract, 'protocol_version': 1}}, 'INVALID_AUTHORIZATION')]:
                self.save(credential_file, {**credentials, **changes})
                self.assert_error(code, send)
            self.assertEqual(len(server.requests), 1)
            rejected = self.cli(['send', '--state-file', str(self.state), '--session-file', str(credential_file)])
            self.assertEqual(rejected.returncode, 1)

    def test_09_legacy_state_uses_current_oauth_without_changing_saved_operation(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            metadata = {**self.metadata, 'operation_id': 'legacy-operation', 'size_bytes': len(self.original),
                        'sha256': hashlib.sha256(self.original).hexdigest(), 'future': {'retained': None}}
            for state in [
                    {'version': 1},
                    {'version': 2, 'protocol': {'protocol_version': 1, 'method': 'POST',
                                              'url': self.origin + '/upload', 'max_metadata_bytes': 16384}}]:
                self.save(self.state, {**state, 'origin': self.origin, 'file': str(self.file), 'metadata': metadata})
                before = self.state.read_bytes()
                self.assertEqual(self.send()['exitCode'], 0)
                sent = json.loads(server.requests[-1]['body'].split(b'\r\n\r\n')[1].split(b'\r\n--')[0])
                self.assertEqual(sent, metadata)
                self.assertTrue(server.requests[-1]['line'].startswith(b'POST /mcp/upload '))
                self.assertEqual(server.requests[-1]['headers']['cf-access-token'], TOKEN)
                self.assertEqual(self.state.read_bytes(), before)

    def test_10_private_file_security_all_four_inputs(self):
        self.prepare()
        exercised_links = []
        for name, operation, argument in [('state', self.send, 'state_file'), ('authorization_file', self.send, 'authorization_file'),
                                          ('metadata_file', self.prepare, 'metadata_file'), ('contract_file', self.prepare, 'contract_file')]:
            filename = getattr(self, name)
            link = filename.with_suffix('.link')
            try:
                link.symlink_to(filename)
            except OSError:
                if os.name != 'nt':
                    raise
                # Directory reparse points do not need Windows symlink privileges; tested below.
            else:
                self.assert_error('UNSAFE_PRIVATE_FILE', operation, **{argument: str(link)})
                exercised_links.append(name + ':symlink')
            self.assert_error('UNSAFE_PRIVATE_FILE', operation, **{argument: str(self.directory)})
            if os.name != 'nt':
                filename.chmod(0o644)
                self.assert_error('UNSAFE_PRIVATE_FILE', operation)
                filename.chmod(0o600)
        if os.name == 'nt':
            junction = self.directory / 'junction'
            made = subprocess.run(['cmd', '/c', 'mklink', '/J', str(junction), str(self.directory)], capture_output=True)
            self.assertEqual(made.returncode, 0, made.stderr.decode(errors='replace'))
            try:
                self.assert_error('UNSAFE_PRIVATE_FILE', upload.private_json, filename=str(junction))
                exercised_links.append('junction:reparse')
                print('Windows final reparse coverage: ' + ', '.join(exercised_links))
            finally:
                junction.rmdir()
        else:
            fifo = self.directory / 'fifo'
            os.mkfifo(fifo, 0o600)
            self.assert_error('UNSAFE_PRIVATE_FILE', upload.private_json, filename=str(fifo))
            with patch.object(upload.os, 'getuid', return_value=self.state.stat().st_uid + 1):
                self.assert_error('UNSAFE_PRIVATE_FILE', self.send)
        self.metadata_file.write_bytes(b' ' * (262144 + 1))
        self.assert_error('UNSAFE_PRIVATE_FILE', self.prepare)

    def test_11_cli_fixed_length_metadata_first_same_operation_no_redirects_token_args(self):
        with HTTPServer(response(200, json.dumps({'resource': {'state': 'deleted'}, 'token': TOKEN}).encode())) as server:
            self.set_origin(server.origin)
            prepared = self.cli(self.args(), env={**os.environ, 'PYTHONIOENCODING': 'ascii'})
            self.assertEqual(prepared.returncode, 0, prepared.stderr)
            operation_id = json.loads(prepared.stdout)['operation_id']
            args = ['send', '--state-file', str(self.state), '--authorization-file', str(self.authorization_file)]
            for _index in range(2):
                sent = self.cli(args)
                self.assertEqual(sent.returncode, 0, sent.stderr)
                self.assertEqual(json.loads(sent.stdout), {'operation_id': operation_id, 'transport_status': 'response_received', 'http_status': 200})
                self.assertNotIn(TOKEN, sent.stdout + sent.stderr)
            for req in server.requests:
                self.assertEqual(req['headers']['cf-access-token'], TOKEN)
                self.assertEqual(int(req['headers']['content-length']), len(req['body']))
                self.assertLess(req['body'].find(b'name="metadata"'), req['body'].find(b'name="file"'))
                self.assertIn(self.original, req['body'])
            server.response = b'HTTP/1.1 307 Test\r\nLocation: /leak\r\nContent-Length: 43\r\n\r\n' + TOKEN.encode()
            sent = self.cli(args)
            self.assertEqual(sent.returncode, 1)
            self.assertEqual(len(server.requests), 3)
            self.assertTrue(all(req['line'].startswith(b'POST /mcp/upload ') for req in server.requests))
            self.assertEqual(json.loads(sent.stdout)['http_status'], 307)
            self.assertNotIn(TOKEN, sent.stdout + sent.stderr)
            invalid = self.cli(['send', '--token', TOKEN])
            self.assertEqual(invalid.returncode, 1)
            self.assertNotIn(TOKEN, invalid.stderr)
            unknown = self.cli(['prepare', '--file', TOKEN])
            self.assertNotIn(TOKEN, unknown.stderr)

    def test_12_complete_responses_only_status_safe_optional_code(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            operation_id = self.prepare()['operation_id']
            for status in [200, 201, 202, 204, 307, 400, 401, 409, 422, 500, 503]:
                for body in [b'', TOKEN.encode(), b'{"resource":{"state":"deleted","accessible":false,"expires_at":-1},"error":{"code":"FUTURE_CODE"}}']:
                    server.response = response(status, b'' if status == 204 else body)
                    sent = self.send()
                    self.assertEqual(sent['exitCode'], 0 if 200 <= status < 300 else 1)
                    self.assertEqual(sent['result']['transport_status'], 'response_received')
                    self.assertEqual(sent['result']['operation_id'], operation_id)
                    self.assertTrue(sent['result'].keys() <= {'operation_id', 'transport_status', 'http_status', 'error_code'})
                    self.assertNotIn(TOKEN, json.dumps(sent))
            server.response = response(200, json.dumps({'error': {'code': 'unsafe\n' + TOKEN}}).encode())
            self.assertNotIn('error_code', self.send()['result'])
            server.response = response(503, b'{"error":{"code":"FUTURE_CODE"}}')
            self.assertEqual(self.send()['result']['error_code'], 'FUTURE_CODE')
            server.response = response(200, b'hello', chunked=True)
            self.assertEqual(self.send()['exitCode'], 0)

    def test_13_request_failure_truncated_oversized_response_no_retry(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            operation_id = self.prepare()['operation_id']
            for raw in [b'HTTP/1.1 401 Test\r\nContent-Length: 10\r\n\r\nshort',
                        b'HTTP/1.1 401 Test\r\nTransfer-Encoding: chunked\r\n\r\n6\r\nshort',
                        b'HTTP/1.1 401 Test\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n',
                        b'HTTP/1.1 401 Test\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n',
                        response(401, b'x' * 262145)]:
                server.response = raw
                sent = self.send()
                self.assertEqual(sent, {'exitCode': 2, 'result': {'operation_id': operation_id,
                                                               'transport_status': 'response_incomplete', 'http_status': 401}})
            self.assertEqual(len(server.requests), 5)
        # A closed localhost listener exercises native connect failure without a transport double.
        sent = self.send()
        self.assertEqual(sent, {'exitCode': 2, 'result': {'operation_id': operation_id, 'transport_status': 'request_failed'}})
        self.assertNotIn(TOKEN, json.dumps(sent))

    def test_14_copied_skill_prepare_chinese_space_paths_no_dependencies(self):
        installed = self.directory / '安装 Skill'
        shutil.copytree(SCRIPT.parent.parent, installed)
        prepared = self.cli(self.args(), script=installed / 'scripts/upload.py')
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        self.assertEqual(json.loads(prepared.stdout)['sha256'], hashlib.sha256(self.original).hexdigest())

    def test_early_complete_401_409_307_stop_real_large_body(self):
        for status in [401, 409, 307]:
            with HTTPServer(response(status, b'{"error":{"code":"EARLY_RESPONSE"}}'), early=True, hold=True) as server:
                self.set_origin(server.origin)
                self.file.write_bytes(b'X' * (16 * 1024 * 1024))
                state = self.directory / f'early{status}.json'
                operation_id = self.prepare(state)['operation_id']
                before = state.read_bytes()
                started = time.monotonic()
                sent = self.send(state)
                self.assertLess(time.monotonic() - started, 2)
                self.assertEqual(sent, {'exitCode': 1, 'result': {'operation_id': operation_id,
                                                                'transport_status': 'response_received', 'http_status': status,
                                                                'error_code': 'EARLY_RESPONSE'}})
                self.assertEqual(len(server.requests), 1)
                self.assertLess(len(server.requests[0]['body']), int(server.requests[0]['headers']['content-length']))
                self.assertEqual(state.read_bytes(), before)
                self.assertFalse(any(thread.name == 'upload-body' for thread in threading.enumerate()))

    def test_socket_timeout_retains_state_and_operation(self):
        for raw, classification in [(None, 'request_failed'), (b'HTTP/1.1 401 Test\r\nContent-Length: 10\r\n\r\n', 'response_incomplete')]:
            with HTTPServer(raw, early=True, hold=True) as server:
                self.set_origin(server.origin)
                state = self.directory / (classification + '.json')
                operation_id = self.prepare(state)['operation_id']
                before = state.read_bytes()
                with patch.object(upload, 'SOCKET_TIMEOUT', 0.1):
                    sent = self.send(state)
                self.assertEqual(sent['exitCode'], 2)
                self.assertEqual(sent['result']['transport_status'], classification)
                self.assertEqual(sent['result']['operation_id'], operation_id)
                self.assertEqual(state.read_bytes(), before)

    @unittest.skipIf(os.name == 'nt', 'Windows terminate uses uncatchable TerminateProcess; state remains durable')
    def test_cli_sigterm_after_http_preserves_operation_no_retry(self):
        import signal
        with HTTPServer(None, early=True, hold=True) as server:
            self.set_origin(server.origin)
            prepared = self.prepare()
            before = self.state.read_bytes()
            child = subprocess.Popen([sys.executable, str(SCRIPT), 'send', '--state-file', str(self.state),
                                      '--authorization-file', str(self.authorization_file)], cwd=self.directory,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertTrue(server.ready.wait(5))
            child.send_signal(signal.SIGTERM)
            stdout, stderr = child.communicate(timeout=5)
            self.assertEqual(child.returncode, 2, stderr)
            self.assertEqual(json.loads(stdout), {'operation_id': prepared['operation_id'], 'transport_status': 'request_failed'})
            self.assertEqual(self.state.read_bytes(), before)
            self.assertEqual(len(server.requests), 1)
            self.assertNotIn(TOKEN.encode(), stdout + stderr)

    def test_js_json_integer_float_unicode_order_and_byte_limit(self):
        raw = '{"2":"two","10":"ten","01":"leading","number":1.0,"negative":-0.0,"tiny":0.0000001,"edge":0.000001,"unicode":"中\\ud83d\\ude00","lone":"\\ud800","line":"\\u2028","bool":true}'
        value = upload.parse_json(raw)
        expected = '{"2":"two","10":"ten","01":"leading","number":1,"negative":0,"tiny":1e-7,"edge":0.000001,"unicode":"中😀","lone":"\\ud800","line":"\u2028","bool":true}'.encode()
        self.assertEqual(upload.json_bytes(value), expected)
        self.assertEqual(type(value['number']), int)
        self.metadata_file.write_text(raw, encoding='utf-8')
        with patch.object(upload.uuid, 'uuid4', return_value='fixed-operation'):
            self.prepare()
        metadata = json.loads(self.state.read_bytes())['metadata']
        limit = len(upload.json_bytes(metadata))
        self.save(self.contract_file, {**self.contract, 'max_metadata_bytes': limit})
        with patch.object(upload.uuid, 'uuid4', return_value='fixed-operation'):
            self.prepare(self.directory / 'exact.json')
            self.save(self.contract_file, {**self.contract, 'max_metadata_bytes': limit - 1})
            self.assert_error('INVALID_METADATA', self.prepare, state=self.directory / 'too-small.json')

    def test_unknown_local_errors_do_not_leak_paths_or_tokens(self):
        args = self.args()
        args[args.index('--file') + 1] = str(self.directory / TOKEN)
        result = self.cli(args)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr)['error_code'], 'LOCAL_ERROR')
        self.assertNotIn(TOKEN, result.stderr)
        self.assertEqual(result.stdout, '')

    def test_cli_supports_equals_options_before_command_and_last_duplicate(self):
        args = ['--state-file=' + str(self.state), '--file=' + str(self.file), '--origin=' + self.origin,
                '--metadata-file=' + str(self.metadata_file), '--contract-file=' + str(self.contract_file),
                '--state-file', str(self.state), 'prepare']
        prepared = self.cli(args)
        self.assertEqual(prepared.returncode, 0, prepared.stderr)
        self.assertEqual(json.loads(prepared.stdout)['state_file'], str(self.state))
        self.assertEqual(self.cli(['--unknown=' + TOKEN, '--help']).returncode, 1)

    def test_response_invalid_json_constants_never_exposes_error_code(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            self.prepare()
            for raw in [b'{"n":NaN,"error":{"code":"FUTURE_CODE"}}', b'{"n":Infinity,"error":{"code":"FUTURE_CODE"}}']:
                server.response = response(200, raw)
                sent = self.send()
                self.assertEqual(sent['exitCode'], 0)
                self.assertNotIn('error_code', sent['result'])

    def test_invalid_ambiguous_response_framing_is_incomplete(self):
        with HTTPServer() as server:
            self.set_origin(server.origin)
            self.prepare()
            for headers in [b'Content-Length: garbage', b'Content-Length: -1', b'Content-Length: ' + b'9' * 5000,
                            b'Content-Length: 0\r\nContent-Length: 1', b'Transfer-Encoding: unsupported',
                            b'Transfer-Encoding: chunked\r\nContent-Length: 0']:
                server.response = b'HTTP/1.1 200 OK\r\n' + headers + b'\r\n\r\n'
                sent = self.send()
                self.assertEqual(sent['exitCode'], 2)
                self.assertEqual(sent['result']['transport_status'], 'response_incomplete')

    def test_tls_real_upload_tickets_and_early_responses(self):
        # Public, disposable localhost fixture key; trust is added only to this test process.
        context = ssl.create_default_context(cafile=str(Path(__file__).with_name('localhost-cert.pem')))
        with patch.object(upload.ssl, '_create_default_https_context', return_value=context):
            for status in [200, 401, 409, 307]:
                with HTTPServer(response(status), tls=True, early=status != 200, hold=status != 200) as server:
                    self.set_origin(server.origin)
                    self.file.write_bytes(b'T' * (16 * 1024 * 1024))
                    state = self.directory / f'tls{status}.json'
                    operation_id = self.prepare(state)['operation_id']
                    sent = self.send(state)
                    self.assertEqual(sent, {'exitCode': 0 if status == 200 else 1,
                                            'result': {'operation_id': operation_id, 'transport_status': 'response_received', 'http_status': status}})
                    self.assertEqual(len(server.requests), 1)
                    if status == 200:
                        self.assertEqual(len(server.requests[0]['body']), int(server.requests[0]['headers']['content-length']))

    def test_interim_100_and_103_allow_body_to_continue(self):
        for status in [100, 103]:
            with HTTPServer(response(201), interim=f'HTTP/1.1 {status} Interim\r\nLink: </example>\r\n\r\n'.encode()) as server:
                self.set_origin(server.origin)
                self.file.write_bytes(b'I' * (16 * 1024 * 1024))
                state = self.directory / f'interim{status}.json'
                self.prepare(state)
                self.assertEqual(self.send(state)['result']['http_status'], 201)
                self.assertEqual(len(server.requests[0]['body']), int(server.requests[0]['headers']['content-length']))

    def test_hash_detects_same_size_mutation_with_restored_mtime_on_same_handle(self):
        self.file.write_bytes(b'A' * 131072)
        before = self.file.stat()
        with upload.open_source(self.file) as source:
            read = source.read
            changed = False

            def mutate_after_read(size):
                nonlocal changed
                result = read(size)
                if not changed:
                    changed = True
                    with self.file.open('r+b') as writer:
                        writer.seek(131071)
                        writer.write(b'B')
                        writer.flush()
                        os.fsync(writer.fileno())
                    os.utime(self.file, ns=(before.st_atime_ns, before.st_mtime_ns))
                return result

            with patch.object(source, 'read', mutate_after_read):
                self.assert_error('FILE_CHANGED', upload.inspect_file, source=source)


if __name__ == '__main__':
    unittest.main()
