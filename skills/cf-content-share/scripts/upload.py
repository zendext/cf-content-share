#!/usr/bin/env python3
"""Python 3.12+ standard-library upload transport. Business decisions stay with the Agent."""
import errno
import hashlib
import http.client
import io
import json
import math
import os
import re
import socket
import select
import ssl
import signal
import stat
import sys
import time
from urllib.parse import quote, urlsplit, urlunsplit
import uuid

MAX_METADATA_BYTES = 128 * 1024
MAX_PRIVATE_BYTES = 256 * 1024
MAX_SAFE_INTEGER = 9007199254740991
CHUNK_BYTES = 65536
SOCKET_TIMEOUT = 30
GENERATED_FIELDS = ('operation_id', 'size_bytes', 'sha256')
SAFE_ERRORS = {
    'INVALID_ARGUMENTS', 'INVALID_ORIGIN', 'INVALID_FILE', 'INVALID_METADATA',
    'INVALID_CONTRACT', 'INVALID_STATE', 'INVALID_SESSION', 'INVALID_PRIVATE_JSON',
    'UNSAFE_PRIVATE_FILE', 'STATE_EXISTS', 'FILE_CHANGED', 'SESSION_EXPIRED',
    'SESSION_ORIGIN_MISMATCH', 'INVALID_AUTHORIZATION', 'AUTHORIZATION_EXPIRED',
    'AUTHORIZATION_ORIGIN_MISMATCH',
}


class UploadError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def fail(code):
    raise UploadError(code)


def safe_json(value, depth=0):
    if depth > 64:
        return False
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, (int, float)):
        return math.isfinite(value) and (not float(value).is_integer() or abs(value) <= MAX_SAFE_INTEGER)
    if isinstance(value, list):
        return all(safe_json(item, depth + 1) for item in value)
    return isinstance(value, dict) and all(safe_json(item, depth + 1) for item in value.values())


def json_number(raw):
    # JSON.parse uses IEEE-754 numbers; integer-valued floats must reach serde as integers.
    number = float(raw)
    return int(number) if math.isfinite(number) and number.is_integer() else number


def reject_json_constant(_raw):
    raise ValueError('Nonstandard JSON constant')


def parse_json(raw):
    value = json.loads(raw, parse_int=json_number, parse_float=json_number,
                       parse_constant=reject_json_constant)
    if not safe_json(value):
        fail('INVALID_PRIVATE_JSON')
    return value


def json_text(value):
    """Compact JSON.stringify spelling/order for safe JSON (including old saved metadata)."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, str):
        text = json.dumps(value, ensure_ascii=False)
        return ''.join(f'\\u{ord(char):04x}' if 0xD800 <= ord(char) <= 0xDFFF else char for char in text)
    if isinstance(value, (int, float)):
        if float(value).is_integer():
            return str(int(value))
        text = repr(value)
        if 'e' in text:
            mantissa, exponent = text.split('e')
            power = int(exponent)
            if power >= -6:
                # Integer magnitudes are already handled above, so only tiny decimals need expansion.
                digits = mantissa.replace('.', '')
                sign = '-' if digits.startswith('-') else ''
                digits = digits.lstrip('-')
                return sign + '0.' + '0' * (-power - 1) + digits
            return mantissa + 'e' + ('+' if power >= 0 else '-') + str(abs(power))
        return text
    if isinstance(value, list):
        return '[' + ','.join(json_text(item) for item in value) + ']'
    # JS enumerates canonical array-index keys before other keys, preserving other insertion order.
    indexes = sorted((key for key in value if re.fullmatch(r'0|[1-9][0-9]*', key)
                      and len(key) <= 10 and int(key) < 4294967295), key=int)
    keys = indexes + [key for key in value if key not in indexes]
    return '{' + ','.join(json_text(key) + ':' + json_text(value[key]) for key in keys) + '}'


def json_bytes(value):
    return json_text(value).encode('utf-8')


def integer(value):
    return type(value) is int and abs(value) <= MAX_SAFE_INTEGER


def parsed_url(value, code):
    if not isinstance(value, str) or any(ord(char) <= 32 for char in value) or '\\' in value:
        fail(code)
    try:
        url = urlsplit(value)
        if not url.hostname or url.username is not None or url.password is not None or url.fragment:
            fail(code)
        host = url.hostname.encode('idna').decode('ascii').lower()
        if url.scheme != 'https' and not (url.scheme == 'http' and host in ('localhost', '127.0.0.1', '::1')):
            fail(code)
        port = url.port
        if port == (443 if url.scheme == 'https' else 80):
            port = None
        authority = ('[' + host + ']' if ':' in host else host) + (':' + str(port) if port is not None else '')
        origin = url.scheme + '://' + authority
        return url, origin
    except (ValueError, UnicodeError):
        fail(code)


def normalize_origin(value):
    url, origin = parsed_url(value, 'INVALID_ORIGIN')
    if url.path not in ('', '/') or url.query:
        fail('INVALID_ORIGIN')
    return origin


def endpoint(value, origin, code):
    url, actual = parsed_url(value, code)
    if actual != origin:
        fail(code)
    return urlunsplit((url.scheme, actual.split('://', 1)[1],
                       quote(url.path or '/', safe="/%:@!$&'()*+,;=-._~"),
                       quote(url.query, safe="/%?:@!$&'()*+,;=-._~"), ''))


def open_private(filename):
    if os.name != 'nt':
        return os.fdopen(os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb')
    # Open the final reparse point itself; inspect and read the very same Windows handle.
    # ACL privacy is deliberately the caller's responsibility.
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class FileInfo(ctypes.Structure):
        _fields_ = [('attributes', wintypes.DWORD), ('creation', wintypes.FILETIME),
                    ('access', wintypes.FILETIME), ('write', wintypes.FILETIME),
                    ('volume', wintypes.DWORD), ('size_high', wintypes.DWORD),
                    ('size_low', wintypes.DWORD), ('links', wintypes.DWORD),
                    ('index_high', wintypes.DWORD), ('index_low', wintypes.DWORD)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileInformationByHandle.argtypes = [wintypes.HANDLE, ctypes.POINTER(FileInfo)]
    kernel.GetFileInformationByHandle.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.CreateFileW(os.fspath(filename), 0x80000000, 7, None, 3, 0x02200000, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        info = FileInfo()
        if not kernel.GetFileInformationByHandle(handle, ctypes.byref(info)):
            raise ctypes.WinError(ctypes.get_last_error())
        if info.attributes & (0x400 | 0x10):  # FILE_ATTRIBUTE_REPARSE_POINT | DIRECTORY
            fail('UNSAFE_PRIVATE_FILE')
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None  # descriptor now owns the native handle
        return os.fdopen(descriptor, 'rb')
    finally:
        if handle is not None:
            kernel.CloseHandle(handle)


def private_json(filename):
    try:
        with open_private(filename) as source:
            info = os.fstat(source.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_PRIVATE_BYTES
                    or (os.name != 'nt' and (info.st_mode & 0o077 or info.st_uid != os.getuid()))):
                fail('UNSAFE_PRIVATE_FILE')
            raw = source.read(MAX_PRIVATE_BYTES + 1)
            if len(raw) > MAX_PRIVATE_BYTES:
                fail('UNSAFE_PRIVATE_FILE')
            return parse_json(raw.decode('utf-8'))
    except UploadError as error:
        if error.code == 'UNSAFE_PRIVATE_FILE':
            raise
        fail('INVALID_PRIVATE_JSON')
    except OSError as error:
        fail('UNSAFE_PRIVATE_FILE' if error.errno in (errno.ELOOP, errno.EISDIR) else 'INVALID_PRIVATE_JSON')
    except (ValueError, UnicodeError, RecursionError, OverflowError):
        fail('INVALID_PRIVATE_JSON')


def open_source(filename):
    return os.fdopen(os.open(filename, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0)), 'rb')


def file_change_time(source):
    if os.name != 'nt':
        return os.fstat(source.fileno()).st_ctime_ns
    import ctypes
    from ctypes import wintypes
    import msvcrt

    class BasicInfo(ctypes.Structure):
        _fields_ = [('creation', ctypes.c_longlong), ('access', ctypes.c_longlong),
                    ('write', ctypes.c_longlong), ('change', ctypes.c_longlong), ('attributes', wintypes.DWORD)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    info = BasicInfo()
    if not kernel.GetFileInformationByHandleEx(msvcrt.get_osfhandle(source.fileno()), 0, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    return info.change


def inspect_file(source):
    before = os.fstat(source.fileno())
    before_change = file_change_time(source)
    if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_SAFE_INTEGER:
        fail('INVALID_FILE')
    source.seek(0)
    digest = hashlib.sha256()
    size = 0
    while chunk := source.read(CHUNK_BYTES):
        digest.update(chunk)
        size += len(chunk)
    after = os.fstat(source.fileno())
    if (before.st_size, before.st_mtime_ns, before_change) != (after.st_size, after.st_mtime_ns, file_change_time(source)) or size != after.st_size:
        fail('FILE_CHANGED')
    return {'size_bytes': size, 'sha256': digest.hexdigest()}


def valid_metadata(value, limit):
    return (isinstance(value, dict) and isinstance(value.get('operation_id'), str)
            and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value['operation_id']) is not None
            and integer(value.get('size_bytes')) and value['size_bytes'] >= 0
            and isinstance(value.get('sha256'), str) and re.fullmatch(r'[a-f0-9]{64}', value['sha256']) is not None
            and len(json_bytes(value)) <= limit)


def protocol(value, origin):
    if (not isinstance(value, dict) or type(value.get('protocol_version')) is not int
            or value['protocol_version'] not in (1, 2) or value.get('method') != 'POST'
            or not integer(value.get('max_metadata_bytes')) or not 1 <= value['max_metadata_bytes'] <= MAX_METADATA_BYTES):
        fail('INVALID_CONTRACT')
    return {'protocol_version': value['protocol_version'], 'method': 'POST',
            'url': endpoint(value.get('url'), origin, 'INVALID_CONTRACT'),
            'max_metadata_bytes': value['max_metadata_bytes']}


def prepare_upload(*, file, origin, state_file, metadata_file, contract_file):
    origin = normalize_origin(origin)
    contract = private_json(contract_file)
    upload = protocol(contract, origin)
    authorization = 'Bearer <token>' if upload['protocol_version'] == 1 else 'Cf-Access-Token: <token>'
    if (contract.get('authorization') != authorization or not isinstance(contract.get('generated_fields'), list)
            or len(contract['generated_fields']) != len(GENERATED_FIELDS)
            or not all(field in contract['generated_fields'] for field in GENERATED_FIELDS)):
        fail('INVALID_CONTRACT')
    metadata = private_json(metadata_file)
    if not isinstance(metadata, dict) or any(field in metadata for field in GENERATED_FIELDS):
        fail('INVALID_METADATA')
    with open_source(file) as source:
        metadata = {**metadata, 'operation_id': str(uuid.uuid4()), **inspect_file(source)}
    if not valid_metadata(metadata, upload['max_metadata_bytes']):
        fail('INVALID_METADATA')
    state = {'version': 2, 'origin': origin, 'file': os.path.abspath(file), 'protocol': upload, 'metadata': metadata}
    if not safe_json(state):
        fail('INVALID_METADATA')
    serialized = json_bytes(state) + b'\n'
    if len(serialized) > MAX_PRIVATE_BYTES:
        fail('INVALID_STATE')
    try:
        descriptor = os.open(state_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fail('STATE_EXISTS')
    with os.fdopen(descriptor, 'wb') as output:
        output.write(serialized)
        output.flush()
        os.fsync(output.fileno())
    return {**{field: metadata[field] for field in GENERATED_FIELDS}, 'state_file': os.path.abspath(state_file)}


class CompleteHTTPResponse(http.client.HTTPResponse):
    def _read_status(self):
        version, status, reason = super()._read_status()
        # HTTPResponse.begin already discards 100; other interim hints use the same flow.
        return version, 100 if 100 <= status < 200 and status != 101 else status, reason

    def _read_and_discard_trailer(self):
        # CPython accepts EOF in trailers. Require the final CRLF and bound discarded headers.
        size = 0
        while True:
            line = self.fp.readline(http.client._MAXLINE + 1)
            size += len(line)
            if len(line) > http.client._MAXLINE or size > MAX_PRIVATE_BYTES or not line.endswith(b'\r\n'):
                raise http.client.IncompleteRead(b'')
            if line == b'\r\n':
                return


def body_chunks(source, prefix, suffix, size):
    for offset in range(0, len(prefix), CHUNK_BYTES):
        yield prefix[offset:offset + CHUNK_BYTES]
    source.seek(0)
    remaining = size
    while remaining:
        chunk = source.read(min(CHUNK_BYTES, remaining))
        if not chunk:
            fail('FILE_CHANGED')
        remaining -= len(chunk)
        yield chunk
    yield suffix


class ResponsePrefix(io.RawIOBase):
    """The standard HTTP parser reads already received bytes before the same socket."""
    def __init__(self, network_socket, prefix):
        self.prefix = io.BytesIO(prefix)
        self.stream = network_socket.makefile('rb', buffering=0)

    def readable(self):
        return True

    def readinto(self, target):
        count = self.prefix.readinto(target)
        return count if count else self.stream.readinto(target)

    def close(self):
        self.stream.close()
        self.prefix.close()
        super().close()


class ResponseSocket:
    def __init__(self, network_socket, prefix):
        self.network_socket, self.prefix = network_socket, prefix

    def makefile(self, _mode):
        return io.BufferedReader(ResponsePrefix(self.network_socket, self.prefix))


def stream_request(network_socket, chunks):
    """Single-thread nonblocking TLS/TCP I/O: readability alone is not an HTTP response."""
    network_socket.setblocking(False)
    incoming = bytearray()
    deadline = time.monotonic() + SOCKET_TIMEOUT
    send_wait, receive_wait = 'write', 'read'
    for chunk in chunks:
        offset = 0
        while offset < len(chunk):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            pending = isinstance(network_socket, ssl.SSLSocket) and network_socket.pending() > 0
            write_sockets = [network_socket] if send_wait == 'write' or receive_wait == 'write' else []
            readable, writable, _ = select.select([network_socket], write_sockets, [], 0 if pending else remaining)
            if pending or readable or (receive_wait == 'write' and writable):
                try:
                    data = network_socket.recv(CHUNK_BYTES)
                    if not data:
                        if incoming:
                            return bytes(incoming)
                        raise ConnectionError
                    incoming.extend(data)
                    receive_wait = 'read'
                    deadline = time.monotonic() + SOCKET_TIMEOUT
                    # Informational responses allow the body to continue. Parse final responses
                    # with http.client as soon as their status line arrives, before body completion.
                    while b'\r\n' in incoming:
                        status_line = incoming.split(b'\r\n', 1)[0].split(b' ')
                        if len(status_line) < 2 or not status_line[1].isdigit() or not 100 <= int(status_line[1]) < 200 or int(status_line[1]) == 101:
                            return bytes(incoming)
                        if b'\r\n\r\n' not in incoming:
                            break
                        del incoming[:incoming.index(b'\r\n\r\n') + 4]
                    if len(incoming) > http.client._MAXLINE:
                        raise http.client.LineTooLong('status line')
                except (BlockingIOError, ssl.SSLWantReadError):
                    receive_wait = 'read'
                except ssl.SSLWantWriteError:
                    receive_wait = 'write'
            if (send_wait == 'write' and writable) or (send_wait == 'read' and readable):
                try:
                    sent = network_socket.send(memoryview(chunk)[offset:])
                    if not sent:
                        raise ConnectionError
                    offset += sent
                    send_wait = 'write'
                    deadline = time.monotonic() + SOCKET_TIMEOUT
                except (BlockingIOError, ssl.SSLWantWriteError):
                    send_wait = 'write'
                except ssl.SSLWantReadError:
                    send_wait = 'read'
    return bytes(incoming)


def transport(url, token, source, prefix, suffix, size, boundary, operation_id, cloudflare_access=False):
    result = {'operation_id': operation_id, 'transport_status': 'request_failed'}
    parsed = urlsplit(url)
    connection_class = http.client.HTTPSConnection if parsed.scheme == 'https' else http.client.HTTPConnection
    connection = connection_class(parsed.hostname, parsed.port, timeout=SOCKET_TIMEOUT)
    network_socket = None
    response = None
    try:
        connection.connect()
        connection.auto_open = False
        network_socket = connection.sock
        connection.putrequest('POST', parsed.path + ('?' + parsed.query if parsed.query else ''))
        if cloudflare_access:
            connection.putheader('Cf-Access-Token', token)
        else:
            connection.putheader('Authorization', 'Bearer ' + token)
        connection.putheader('Content-Type', 'multipart/form-data; boundary=' + boundary)
        connection.putheader('Content-Length', str(len(prefix) + size + len(suffix)))
        connection.endheaders()
        received = stream_request(network_socket, body_chunks(source, prefix, suffix, size))
        network_socket.settimeout(SOCKET_TIMEOUT)
        response = CompleteHTTPResponse(ResponseSocket(network_socket, received), method='POST')
        response.begin()
        result.update(http_status=response.status, transport_status='response_incomplete')
        lengths = response.headers.get_all('Content-Length', [])
        encodings = response.headers.get_all('Transfer-Encoding', [])
        if (len(lengths) > 1 or (lengths and re.fullmatch(r'[0-9]+', lengths[0].strip()) is None)
                or (encodings and (lengths or len(encodings) != 1 or encodings[0].strip().lower() != 'chunked'))):
            return {'exitCode': 2, 'result': result}
        if lengths:
            declared = lengths[0].strip().lstrip('0') or '0'
            maximum = str(MAX_PRIVATE_BYTES)
            if len(declared) > len(maximum) or (len(declared) == len(maximum) and declared > maximum):
                return {'exitCode': 2, 'result': result}
        chunks = []
        total = 0
        while chunk := response.read(min(CHUNK_BYTES, MAX_PRIVATE_BYTES + 1 - total)):
            total += len(chunk)
            if total > MAX_PRIVATE_BYTES:
                return {'exitCode': 2, 'result': result}
            chunks.append(chunk)
        if response.length not in (None, 0):
            return {'exitCode': 2, 'result': result}
        result['transport_status'] = 'response_received'
        try:
            data = json.loads(b''.join(chunks), parse_constant=reject_json_constant)
            error = data.get('error') if isinstance(data, dict) else None
            code = error.get('code') if isinstance(error, dict) else None
            if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,79}', code) and token not in code:
                result['error_code'] = code
        except (ValueError, UnicodeError, RecursionError):
            pass
        return {'exitCode': 0 if 200 <= response.status < 300 else 1, 'result': result}
    except (Exception, KeyboardInterrupt):
        return {'exitCode': 2, 'result': result}
    finally:
        if network_socket is not None:
            try:
                network_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if response is not None:
            response.close()
        connection.close()


def send_upload(*, state_file, session_file=None, authorization_file=None):
    if bool(session_file) == bool(authorization_file):
        fail('INVALID_ARGUMENTS')
    state = private_json(state_file)
    if (not isinstance(state, dict) or type(state.get('version')) is not int or state['version'] not in (1, 2)
            or not isinstance(state.get('file'), str) or not os.path.isabs(state['file'])
            or normalize_origin(state.get('origin')) != state['origin']):
        fail('INVALID_STATE')
    origin = state['origin']
    upload = protocol(state.get('protocol'), origin) if state['version'] == 2 else None
    metadata = state.get('metadata')
    if not valid_metadata(metadata, upload['max_metadata_bytes'] if upload else MAX_METADATA_BYTES):
        fail('INVALID_STATE')
    with open_source(state['file']) as source:
        if inspect_file(source) != {key: metadata[key] for key in ('size_bytes', 'sha256')}:
            fail('FILE_CHANGED')
        session = private_json(authorization_file or session_file)
        cloudflare_access = authorization_file is not None
        invalid_credentials = 'INVALID_AUTHORIZATION' if cloudflare_access else 'INVALID_SESSION'
        token_pattern = r'[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){2}' if cloudflare_access else r'[A-Za-z0-9_-]{43}'
        if (not isinstance(session, dict) or not isinstance(session.get('token'), str)
                or len(session['token']) > 16384 or re.fullmatch(token_pattern, session['token']) is None
                or not integer(session.get('expires_at')) or not isinstance(session.get('upload'), dict)
                or session['upload'].get('method') != 'POST'):
            fail(invalid_credentials)
        session_upload = session['upload']
        expected_version = 2 if cloudflare_access else 1
        if not (type(session_upload.get('protocol_version')) is int and session_upload['protocol_version'] == expected_version):
            legacy_keys = {'url', 'method', 'authorization', 'body', 'metadata_schema', 'recovery'}
            if cloudflare_access or state['version'] != 1 or 'protocol_version' in session_upload or not session_upload.keys() <= legacy_keys:
                fail(invalid_credentials)
        if cloudflare_access and session_upload.get('authorization') != 'Cf-Access-Token: <token>':
            fail(invalid_credentials)
        if session['expires_at'] <= int(time.time()):
            fail('AUTHORIZATION_EXPIRED' if cloudflare_access else 'SESSION_EXPIRED')
        url = endpoint(session_upload.get('url'), origin, 'AUTHORIZATION_ORIGIN_MISMATCH' if cloudflare_access else 'SESSION_ORIGIN_MISMATCH')
        if upload and (upload['protocol_version'] != expected_version or url != upload['url']):
            fail(invalid_credentials)
        boundary = 'cf-share-' + str(uuid.uuid4())
        prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n'.encode()
                  + json_bytes(metadata) + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
        suffix = f'\r\n--{boundary}--\r\n'.encode()
        if len(prefix) + metadata['size_bytes'] + len(suffix) > MAX_SAFE_INTEGER:
            fail('INVALID_FILE')
        return transport(url, session['token'], source, prefix, suffix, metadata['size_bytes'], boundary, metadata['operation_id'], cloudflare_access)


HELP = '''Python 3.12+; standard library only, no npm, pip or virtual environment required.
prepare --file PATH --origin HTTPS_ORIGIN --metadata-file PRIVATE_JSON --contract-file PRIVATE_JSON --state-file NEW_JSON
send    --state-file PRIVATE_JSON --session-file PRIVATE_JSON
send    --state-file PRIVATE_JSON --authorization-file PRIVATE_JSON

prepare preserves metadata, adds operation_id/size_bytes/sha256, and saves a new private state.
Use the credential-free upload object from describe(session.create) or describe(upload.authorization).
send reads the matching invoke result, rechecks the file, and sends once.
Protocol 2 uses the current Cloudflare Access credential from upload.authorization; it requires no second login.
HTTPS required except loopback HTTP. No redirects or automatic retries. Never pass a Token as an argument.
Socket inactivity timeout: 30 seconds. Preserve state and query operation.get after any HTTP attempt.
Exit 0: prepared or complete HTTP 2xx; 1: local input error or complete non-2xx; 2: request failed or response incomplete.
Always query operation.get after send and follow the discovered recovery rules, regardless of exit code.
'''


def write_json(value, stream):
    stream.buffer.write(json_bytes(value) + b'\n')
    stream.buffer.flush()


def main(args):
    try:
        if sys.version_info < (3, 12):
            fail('LOCAL_ERROR')
        options = {'file', 'origin', 'metadata-file', 'contract-file', 'state-file', 'session-file', 'authorization-file'}
        values = {}
        positionals = []
        help_requested = False
        index = 0
        while index < len(args):
            argument = args[index]
            if argument == '--':
                positionals.extend(args[index + 1:])
                break
            if argument == '--help':
                help_requested = True
            elif argument.startswith('--'):
                name, separator, value = argument[2:].partition('=')
                if name not in options:
                    fail('INVALID_ARGUMENTS')
                if not separator:
                    index += 1
                    if index >= len(args) or args[index].startswith('--'):
                        fail('INVALID_ARGUMENTS')
                    value = args[index]
                values[name.replace('-', '_')] = value
            elif argument.startswith('-'):
                fail('INVALID_ARGUMENTS')
            else:
                positionals.append(argument)
            index += 1
        if help_requested:
            print(HELP)
            return 0
        if len(positionals) != 1 or positionals[0] not in ('prepare', 'send'):
            fail('INVALID_ARGUMENTS')
        command = positionals[0]
        allowed = {'file', 'origin', 'metadata_file', 'contract_file', 'state_file'} if command == 'prepare' else {'state_file', 'authorization_file' if 'authorization_file' in values else 'session_file'}
        if values.keys() != allowed or not all(values.values()):
            fail('INVALID_ARGUMENTS')
        if command == 'prepare':
            write_json(prepare_upload(**values), sys.stdout)
            return 0
        sent = send_upload(**values)
        write_json(sent['result'], sys.stdout)
        return sent['exitCode']
    except (Exception, KeyboardInterrupt) as error:
        code = error.code if isinstance(error, UploadError) and error.code in SAFE_ERRORS else 'LOCAL_ERROR'
        write_json({'error_code': code, 'hint': 'Use --help; no upload is retried automatically.'}, sys.stderr)
        return 1


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


if __name__ == '__main__':
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    sys.exit(main(sys.argv[1:]))
