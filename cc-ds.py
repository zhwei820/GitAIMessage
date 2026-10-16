#!/usr/bin/env python3
"""DeepSeek / OpenAI 兼容的 Chat Completions 服务，后端调用本机 Claude Code CLI（claude -p）。

用法:
    python3 ~/cc-ds.py [--host 127.0.0.1] [--port 8000]

环境变量:
    CC_DS_API_KEY    设置后要求请求带 `Authorization: Bearer <key>`
    CC_DS_MODEL      deepseek-chat 映射到的 Claude 模型（默认 sonnet）
    CC_DS_REASONER   deepseek-reasoner 映射到的 Claude 模型（默认 opus）
    CC_DS_CLAUDE     claude 可执行文件路径（默认 claude）
    CC_DS_TIMEOUT    单次请求超时秒数（默认 600）
    CC_DS_VAULT_DIR  密码库目录（默认 ~/.cc-ds），首次启动生成 vault-token 供浏览器扩展填写

/vault 只存浏览器扩展加密后的密文，主密码和明文都不经过本服务。

示例:
    curl http://127.0.0.1:8000/chat/completions -H 'Content-Type: application/json' \
      -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}],"stream":true}'

    from openai import OpenAI
    client = OpenAI(base_url="http://127.0.0.1:8000", api_key="x")
"""

import argparse
import hmac
import json
import os
import shlex
import secrets
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CLAUDE_BIN = os.environ.get("CC_DS_CLAUDE", "claude")
API_KEY = os.environ.get("CC_DS_API_KEY", "")
TIMEOUT = int(os.environ.get("CC_DS_TIMEOUT", "600"))
MODEL_MAP = {
    "deepseek-chat": os.environ.get("CC_DS_MODEL", "sonnet"),
    "deepseek-reasoner": os.environ.get("CC_DS_REASONER", "opus"),
}
CLAUDE_ALIASES = ("sonnet", "opus", "haiku", "fable")

VAULT_DIR = os.path.expanduser(os.environ.get("CC_DS_VAULT_DIR", "~/.cc-ds"))
VAULT_FILE = os.path.join(VAULT_DIR, "vault.json")
VAULT_TOKEN_FILE = os.path.join(VAULT_DIR, "vault-token")
VAULT_BACKUP_DIR = os.path.join(VAULT_DIR, "backups")
VAULT_BACKUP_KEEP = 30
VAULT_MAX_BYTES = 5 << 20
VAULT_HOSTS = ("127.0.0.1", "localhost")
vault_lock = threading.Lock()
VAULT_TOKEN = ""


def map_model(name):
    """DeepSeek 名按 MODEL_MAP 映射；Claude 别名 / claude-* 透传；其余（gpt-4o 等客户端默认值）退回 deepseek-chat 的映射。"""
    if name in MODEL_MAP:
        return MODEL_MAP[name]
    if name.startswith("claude-") or name in CLAUDE_ALIASES:
        return name
    return MODEL_MAP["deepseek-chat"]


# 空目录作为 cwd，避免 claude 读到当前目录的 CLAUDE.md / 项目配置
WORKDIR = tempfile.mkdtemp(prefix="cc-ds-")


def load_vault_token():
    os.makedirs(VAULT_DIR, mode=0o700, exist_ok=True)
    os.chmod(VAULT_DIR, 0o700)
    try:
        with open(VAULT_TOKEN_FILE) as f:
            token = f.read().strip()
        if token:
            return token
    except FileNotFoundError:
        pass
    token = secrets.token_urlsafe(32)
    fd = os.open(VAULT_TOKEN_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    return token


def read_vault():
    try:
        with open(VAULT_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"rev": 0, "blob": None}


def write_vault(rec):
    """先备份旧版本再原子替换：扩展端的 bug 或误操作覆盖了密码库时还能从 backups/ 找回。"""
    if os.path.exists(VAULT_FILE):
        os.makedirs(VAULT_BACKUP_DIR, mode=0o700, exist_ok=True)
        shutil.copy2(VAULT_FILE, os.path.join(VAULT_BACKUP_DIR, f"vault-{rec['rev'] - 1:06d}.json"))
        for old in sorted(os.listdir(VAULT_BACKUP_DIR))[:-VAULT_BACKUP_KEEP]:
            os.remove(os.path.join(VAULT_BACKUP_DIR, old))
    tmp = VAULT_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(rec, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, VAULT_FILE)


def log(msg):
    print(f"[{time.strftime('%d/%b/%Y %H:%M:%S')}] {msg}", flush=True)


class APIError(Exception):
    def __init__(self, status, message, etype="invalid_request_error"):
        super().__init__(message)
        self.status, self.message, self.etype = status, message, etype


def content_to_text(content):
    """OpenAI content 可能是字符串或 [{type:text|input_text|output_text,text:...}] 数组。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts = []
    for p in content:
        if isinstance(p, dict) and p.get("type") in ("text", "input_text", "output_text"):
            parts.append(p.get("text", ""))
    return "".join(parts)


def build_prompt(messages):
    """claude -p 只接受单条 prompt：system 走 --system-prompt，多轮对话拼成转录文本。"""
    if not isinstance(messages, list) or not messages:
        raise APIError(400, "messages must be a non-empty array")
    system = "\n\n".join(content_to_text(m.get("content")) for m in messages if m.get("role") == "system")
    convo = [m for m in messages if m.get("role") != "system"]
    if not convo:
        raise APIError(400, "messages must contain at least one non-system message")

    if len(convo) == 1 and convo[0].get("role") == "user":
        return system, content_to_text(convo[0].get("content"))

    names = {"user": "User", "assistant": "Assistant", "tool": "Tool"}
    lines = ["Below is the conversation so far. Reply as the Assistant to the last User message.", ""]
    for m in convo:
        lines.append(f"<{names.get(m.get('role'), m.get('role'))}>")
        lines.append(content_to_text(m.get("content")))
        lines.append(f"</{names.get(m.get('role'), m.get('role'))}>")
    return system, "\n".join(lines)


def claude_cmd(model, system, stream):
    cmd = [
        CLAUDE_BIN, "-p",
        "--model", model,
        "--tools", "",  # 纯对话，不让 Claude Code 动本机文件/命令
        "--no-session-persistence",
        "--output-format", "stream-json" if stream else "json",
    ]
    if stream:
        cmd += ["--verbose", "--include-partial-messages"]
    if system:
        cmd += ["--system-prompt", system]
    return cmd


def to_usage(u):
    u = u or {}
    prompt = (u.get("input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)
    completion = u.get("output_tokens") or 0
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
        "prompt_cache_hit_tokens": u.get("cache_read_input_tokens") or 0,
        "prompt_cache_miss_tokens": prompt - (u.get("cache_read_input_tokens") or 0),
    }


def run_blocking(cmd, prompt):
    try:
        proc = subprocess.run(
            cmd, input=prompt, capture_output=True,
            text=True, timeout=TIMEOUT, cwd=WORKDIR,
        )
    except subprocess.TimeoutExpired:
        raise APIError(504, "claude timed out", "timeout")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise APIError(502, f"claude failed (exit {proc.returncode}): {proc.stderr.strip() or proc.stdout.strip()}", "api_error")
    if data.get("is_error"):
        raise APIError(502, str(data.get("result") or data), "api_error")
    return data.get("result", ""), data.get("usage")


def iter_stream(cmd, prompt):
    """逐个产出 ("reasoning"|"content", text)，最后产出 ("done", (usage, finish_reason))。"""
    proc = subprocess.Popen(
        cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, cwd=WORKDIR, bufsize=1,
    )
    timer = threading.Timer(TIMEOUT, proc.kill)
    timer.start()
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()
        usage, finish = None, "stop"
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "stream_event":
                e = ev.get("event", {})
                if e.get("type") == "content_block_delta":
                    d = e.get("delta", {})
                    if d.get("type") == "text_delta" and d.get("text"):
                        yield "content", d["text"]
                    elif d.get("type") == "thinking_delta" and d.get("thinking"):
                        yield "reasoning", d["thinking"]
                elif e.get("type") == "message_delta":
                    if e.get("delta", {}).get("stop_reason") == "max_tokens":
                        finish = "length"
            elif ev.get("type") == "result":
                if ev.get("is_error"):
                    raise APIError(502, str(ev.get("result") or ev), "api_error")
                usage = ev.get("usage")
        proc.wait()
        if usage is None:
            raise APIError(502, f"claude exited {proc.returncode}: {proc.stderr.read().strip()}", "api_error")
        yield "done", (usage, finish)
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        log(fmt % args)

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, err):
        self.send_json(err.status, {"error": {"message": err.message, "type": err.etype, "code": None}})

    def check_vault_auth(self):
        """Host 校验挡 DNS rebinding；Origin 只放行扩展（网页跨域请求带 X-Vault-Token 会触发预检，本服务不应答 OPTIONS）。"""
        host = self.headers.get("Host", "").rsplit(":", 1)[0]
        origin = self.headers.get("Origin")
        if host not in VAULT_HOSTS or (origin and not origin.startswith("chrome-extension://")):
            raise APIError(403, "forbidden", "permission_error")
        if not hmac.compare_digest(self.headers.get("X-Vault-Token", "").encode(), VAULT_TOKEN.encode()):
            raise APIError(401, "invalid vault token", "authentication_error")

    def do_PUT(self):
        try:
            if self.path.rstrip("/") != "/vault":
                raise APIError(404, "not found")
            self.check_vault_auth()
            length = int(self.headers.get("Content-Length", 0))
            if length > VAULT_MAX_BYTES:
                raise APIError(413, "vault too large")
            try:
                req = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                raise APIError(400, "invalid JSON body")
            blob, base = req.get("blob"), req.get("baseRev")
            if not isinstance(blob, dict) or not isinstance(base, int):
                raise APIError(400, "blob (object) and baseRev (int) are required")
            with vault_lock:
                cur = read_vault().get("rev", 0)
                if base != cur:
                    self.send_json(409, {"error": {"message": "vault changed on server", "type": "conflict"}, "rev": cur})
                    return
                rec = {"rev": cur + 1, "updatedAt": int(time.time()), "blob": blob}
                write_vault(rec)
            log(f"vault saved rev {rec['rev']}")
            self.send_json(200, {"rev": rec["rev"]})
        except APIError as e:
            self.send_error_json(e)

    def check_auth(self):
        if API_KEY and self.headers.get("Authorization", "") != f"Bearer {API_KEY}":
            raise APIError(401, "Authentication Fails, invalid api key", "authentication_error")

    def do_GET(self):
        try:
            if self.path.rstrip("/") == "/vault":
                self.check_vault_auth()
                with vault_lock:
                    rec = read_vault()
                self.send_json(200, rec)
                return
            self.check_auth()
            if self.path.rstrip("/") in ("/models", "/v1/models"):
                self.send_json(200, {"object": "list", "data": [
                    {"id": name, "object": "model", "owned_by": "cc-ds"} for name in MODEL_MAP
                ]})
            else:
                raise APIError(404, "not found")
        except APIError as e:
            self.send_error_json(e)

    def do_POST(self):
        cid = f"chatcmpl-{uuid.uuid4().hex}"
        start = time.time()
        try:
            # 先读 body 再鉴权/路由：401、404 也能记下请求内容
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            try:
                req = json.loads(raw or b"{}")
                body = json.dumps(req, ensure_ascii=False, indent=2)
            except json.JSONDecodeError:
                req, body = None, raw.decode(errors="replace")
            log(f"{cid} {self.path} request:\n{body}")

            self.check_auth()
            path = self.path.rstrip("/")
            if path not in ("/chat/completions", "/v1/chat/completions", "/responses", "/v1/responses"):
                raise APIError(404, "not found")
            if req is None:
                raise APIError(400, "invalid JSON body")
            if path.endswith("/responses"):
                self.handle_responses(cid, start, req)
                return

            req_model = req.get("model") or "deepseek-chat"
            claude_model = map_model(req_model)
            system, prompt = build_prompt(req.get("messages"))
            stream = bool(req.get("stream"))
            cmd = claude_cmd(claude_model, system, stream)
            log(f"{cid} model {req_model} -> {claude_model}, cmd: {shlex.join(cmd)}")
            created = int(time.time())

            if stream:
                self.stream_response(cid, created, req_model, cmd, prompt,
                                     (req.get("stream_options") or {}).get("include_usage"), start)
                return

            text, usage = run_blocking(cmd, prompt)
            log(f"{cid} response ({time.time() - start:.1f}s) usage={to_usage(usage)}:\n{text}")
            self.send_json(200, {
                "id": cid, "object": "chat.completion", "created": created, "model": req_model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                             "logprobs": None, "finish_reason": "stop"}],
                "usage": to_usage(usage),
            })
        except APIError as e:
            log(f"{cid} error {e.status} ({time.time() - start:.1f}s): {e.message}")
            self.send_error_json(e)

    def handle_responses(self, cid, start, req):
        """OpenAI Responses API 的非流式子集：input（字符串或消息数组）+ instructions。"""
        if req.get("stream"):
            raise APIError(400, "stream is not supported on /responses")
        messages = req.get("input")
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        if req.get("instructions") and isinstance(messages, list):
            messages = [{"role": "system", "content": req["instructions"]}] + messages
        req_model = req.get("model") or "deepseek-chat"
        claude_model = map_model(req_model)
        system, prompt = build_prompt(messages)
        cmd = claude_cmd(claude_model, system, False)
        log(f"{cid} model {req_model} -> {claude_model}, cmd: {shlex.join(cmd)}")

        text, usage = run_blocking(cmd, prompt)
        u = to_usage(usage)
        log(f"{cid} response ({time.time() - start:.1f}s) usage={u}:\n{text}")
        self.send_json(200, {
            "id": f"resp_{cid.removeprefix('chatcmpl-')}", "object": "response",
            "created_at": int(start), "status": "completed", "model": req_model,
            "output": [{"type": "message", "id": f"msg_{uuid.uuid4().hex}", "status": "completed",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text, "annotations": []}]}],
            "output_text": text,
            "usage": {"input_tokens": u["prompt_tokens"], "output_tokens": u["completion_tokens"],
                      "total_tokens": u["total_tokens"]},
        })

    def stream_response(self, cid, created, req_model, cmd, prompt, include_usage, start):
        events = iter_stream(cmd, prompt)
        try:
            first = next(events)  # 先拿到第一个事件再发 200，启动失败还能返回正常的错误码
        except APIError as e:
            log(f"{cid} error {e.status} ({time.time() - start:.1f}s): {e.message}")
            self.send_error_json(e)
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True

        def chunk(delta, finish=None, usage=None):
            obj = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": req_model,
                   "choices": [{"index": 0, "delta": delta, "logprobs": None, "finish_reason": finish}]}
            if usage is not None:
                obj["usage"] = usage
            self.wfile.write(f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        content, reasoning = [], []

        def emit(kind, payload):
            if kind == "content":
                content.append(payload)
                chunk({"content": payload})
            elif kind == "reasoning":
                reasoning.append(payload)
                chunk({"reasoning_content": payload})
            elif kind == "done":
                usage, finish = payload
                log(f"{cid} response ({time.time() - start:.1f}s) finish={finish} usage={to_usage(usage)}")
                chunk({}, finish, to_usage(usage) if include_usage else None)

        def log_output(status):
            text = "".join(content)
            if reasoning:
                text = f"<reasoning>\n{''.join(reasoning)}\n</reasoning>\n{text}"
            log(f"{cid} stream {status} ({time.time() - start:.1f}s):\n{text}")

        try:
            chunk({"role": "assistant", "content": ""})
            emit(*first)
            for kind, payload in events:
                emit(kind, payload)
        except APIError as e:
            log_output(f"error {e.status}: {e.message}")
            err = {"error": {"message": e.message, "type": e.etype, "code": None}}
            self.wfile.write(f"data: {json.dumps(err, ensure_ascii=False)}\n\n".encode())
        except (BrokenPipeError, ConnectionResetError):
            log_output("client disconnected")
            events.close()
            return
        else:
            log_output("done")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


def free_port(port):
    """SIGTERM 占用 port 的监听进程，3 秒未退出则 SIGKILL。"""
    out = subprocess.run(["lsof", "-t", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                         capture_output=True, text=True).stdout
    pids = {int(p) for p in out.split()} - {os.getpid()}
    for pid in pids:
        name = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
        print(f"port {port} in use by pid {pid} ({name}), killing", flush=True)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            continue
    deadline = time.time() + 3
    while pids and time.time() < deadline:
        time.sleep(0.1)
        pids = {p for p in pids if _alive(p)}
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def main():
    ap = argparse.ArgumentParser(description="DeepSeek-compatible API backed by Claude Code")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    global VAULT_TOKEN
    VAULT_TOKEN = load_vault_token()
    free_port(args.port)
    print(f"cc-ds listening on http://{args.host}:{args.port}  models={MODEL_MAP}", flush=True)
    print(f"vault: {VAULT_FILE}  token: {VAULT_TOKEN_FILE}", flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
